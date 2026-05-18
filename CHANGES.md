# CHANGES — Divergences from upstream

Records every change made to skills inherited from [`mattpocock/skills`](https://github.com/mattpocock/skills), plus new skills created by reddb.io. See the rules in [CLAUDE.md](./CLAUDE.md).

Upstream base: `mattpocock/skills@e74f0061bb67222181640effa98c675bdb2fdaa7` (see `.upstream`).

---

## afk (engineering) — generic hook orchestrator + env-file protocol

- **status**: modified
- **upstream**: —
- **why**: PRD #16 needs one place that drives every hook point in the `afk` skill so callers in `supervisor.sh` (pre-spawn / post-exit) and `afk.sh` (pre-iteration / post-iteration / pre-merge / post-merge) don't each re-implement layer chaining, env propagation, and failure semantics. Issue #18 builds that orchestrator: a three-layer chain (shipped detectors → project detectors → project main hook) with a per-invocation env-file protocol so hooks can export values back to the caller, distinct pre vs. post failure semantics (pre aborts; post logs and continues), and an "applied detectors" list other code can render in the boot log.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/hooks.sh`: new — exposes `hooks_run HOOK_POINT` and the `HOOKS_APPLIED_DETECTORS` array. Each subprocess gets its own `mktemp`-allocated `AFK_HOOK_ENV_FILE`; on exit code 0 the file is sourced back into the caller via `set -a; source "$file"; set +a` and then deleted, so vars exported by hooks propagate while temp files never leak. Hook points are hard-coded at v1: pre-spawn / pre-iteration / pre-merge abort on the first non-zero (returning the script's rc); post-exit / post-iteration / post-merge log to stderr and continue. Detector exit code 1 = "not applicable" (never aborts, never applied); any other non-zero is a failure per the pre/post rule. Layers run in C-locale alphabetical order. Layer 1 (shipped) detectors are skipped when `afk.hooks.defaults.<name>` is literally `false` in `.red/config.yaml`; layer 2 (project) detectors are never config-gated. Idempotent via `_AFK_HOOKS_SH_LOADED` guard so both runners can source it.
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: sources `hooks.sh` right after `config.sh` so `hooks_run` is available for the per-iteration / per-merge call sites that will wire up in a later slice.
  - `plugins/dev/skills/engineering/afk/scripts/supervisor.sh`: same — sources `hooks.sh` after `config.sh`, ready for pre-spawn / post-exit wiring.
  - `plugins/dev/skills/engineering/afk/scripts/tests/hooks-orchestrator.test.sh`: new — 27 assertions across the acceptance criteria: empty layers no-op, shipped-detector export propagation, detector exit 1 is N/A (no abort, not applied), shipped exit 2 aborts on pre-spawn but logs-and-continues on post-merge, project detector overrides shipped env value, project main hook overrides both detector layers, alphabetical execution + applied-list ordering across layers, temp env-files cleaned up (counted via private TMPDIR), unknown hook point returns non-zero, main-hook rc propagation on pre-merge vs. swallowed on post-merge, config-driven shipped-detector disable (`cargo: false` in YAML), plus structural checks that both `afk.sh` and `supervisor.sh` source `hooks.sh`.
  - Tests: new hooks-orchestrator suite (27/27) + existing afk suites still green (config-loader 33/33, envelope-shape 37/37, handoff-builder 44/44, runner-detection 14/14, sentinel-detection 5/5, stall-detector 16/16). The pre-existing `statusline.test.sh` failure on `main` is unrelated and untouched.

---

## afk (engineering) — `.red/config.yaml` loader with typed defaults

- **status**: modified
- **upstream**: —
- **why**: PRD #16 needs a single point of truth for per-project plugin settings. Issue #17 carves out the foundational slice: a loader that reads `.red/config.yaml` from the current checkout, merges it over documented defaults, and exposes a typed accessor that downstream modules (runner-detection cascade, fleet supervisor, hook orchestrator) can call without each one re-implementing YAML parsing. Forward-compatibility matters — unknown keys must be silently ignored so older agents tolerate newer configs.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/config.sh`: new — sources cleanly from both `afk.sh` and `supervisor.sh` via an idempotent `_AFK_CONFIG_SH_LOADED` guard. Exposes `config_load [path]` (populates the global `CONFIG_VALUES` assoc-array; missing file → all defaults; malformed YAML → one warning line on stderr, fall back to all defaults) and `config_get KEY` (dotted lookup, e.g. `config_get afk.fleet.target`). Documented v1 defaults: `afk.default_runner=claude`, `afk.fleet.target=2`, `afk.hooks.defaults.cargo=true`, `afk.hooks.defaults.gradle=true`. Parser is a tiny pure-shell scanner — no `yq` dependency — accepting `key: [value]` lines with 2-space indentation, comments (`#`), and single/double quoted scalars. Unknown keys parse fine (stored but unread) for forward compatibility. Malformed detection covers odd-indent and unclosed quotes.
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: sources `config.sh` immediately after computing `SCRIPT_DIR` so every downstream function can call `config_get` without re-parsing.
  - `plugins/dev/skills/engineering/afk/scripts/supervisor.sh`: same — sources `config.sh` right after the discovery block, ahead of any tunables that may later read from config.
  - `plugins/dev/skills/engineering/afk/scripts/tests/config-loader.test.sh`: new — 33 assertions covering missing file (all defaults), partial override (only specified keys replaced), unknown top-level + nested keys (silently ignored, no warning), malformed YAML (unclosed quote and bad indent both fall back with exactly one warning line that names `config.yaml`), every documented v1 default present, nested overrides leaving siblings untouched, integer values round-tripping, comments + blanks ignored, and `afk.sh`/`supervisor.sh` both referencing `config.sh`.
  - Tests: new config-loader suite (33/33) + existing afk suites still green (envelope-shape 37/37, handoff-builder 44/44, runner-detection 14/14, sentinel-detection 5/5, stall-detector 16/16). The pre-existing `statusline.test.sh` failure on `main` is unrelated and untouched.

---

## triage + afk (engineering) — agent brief moves from accumulating comment to issue-body `## Agent brief` section

- **status**: modified
- **upstream**: —
- **why**: Before this change `/triage` posted the AGENT-BRIEF as a fresh GitHub comment on the issue every time it ran. Older briefs were never deleted, so the thread accumulated drift: the most recent comment won, but stale briefs sat indefinitely as silent noise that mis-led human readers (and any future parser tempted to walk the thread). Issue #11 (parent PRD #2) moves the brief to a `## Agent brief` section inside the **issue body**, which `/triage` rewrites in place. Slice C's handoff builder already pipes the issue body verbatim into the inner-agent contract, so the brief rides on the body — no `/afk` code change required.
- **what changed**:
  - `plugins/dev/skills/engineering/triage/AGENT-BRIEF.md`: reframed from "structured comment" to "structured `## Agent brief` body section". Added a *Where it lives in the body* section documenting the canonical body layout (`{arbitrary content} → ## Agent brief → ## Blocked by`, with the noted tolerance that `## Blocked by` may also precede `## Agent brief`). Added an *Editing the issue body* recipe: capture body via `gh issue view --json body`, splice in/replace the section at the next `## ` boundary, write back via `gh issue edit --body-file -`, then leave a one-line disclaimer comment so the thread shows triage touched the issue. Lowercased the section heading to `## Agent brief` across template + three examples to match the canonical key.
  - `plugins/dev/skills/engineering/triage/SKILL.md`: Flow C check now looks for the `## Agent brief` body section instead of "an AGENT-BRIEF on the issue". Outcome table entry for `ready-for-agent` now reads "Write or refresh the `## Agent brief` section in the issue body … Do **not** post the brief as a comment." `ready-for-human` row clarifies the brief lives in the same body slot.
  - `plugins/dev/skills/engineering/afk/SKILL.md`: handoff-file row, per-issue loop step 3, and the handoff template each replaced the "AGENT-BRIEF body" phrasing with "issue body verbatim — which carries the `## Agent brief` section written by `/triage`". No script change — `build_retry_handoff_body` already inlines the issue body under `## Brief`, and `sweep_unblocked`'s awk extractor for `## Blocked by` already tolerates either section order.
  - `plugins/dev/skills/engineering/afk/AGENT-PROMPT.md`: inner-agent prompt's "Inputs" paragraph now points at the `## Agent brief` section inside the body's `## Brief` as the authoritative contract instead of the previous "AGENT-BRIEF posted on the issue" phrasing.
  - `plugins/dev/skills/engineering/setup-red-skills/triage-labels.md` and `.red/agents/triage-labels.md`: `ready-for-agent` state definition rewritten ("issue body contains a complete `## Agent brief` section"); ASCII state-machine diagram updated from `(AGENT-BRIEF posted)` to `(## Agent brief in body)`.
  - `plugins/dev/skills/engineering/report-bug/SKILL.md`: routing note tightened — "AGENT-BRIEF assigned" → "an `## Agent brief` section written into the issue body".
  - Tests: no new tests required. Existing afk suites (envelope-shape 37/37, handoff-builder 44/44, runner-detection 14/14, sentinel-detection 5/5, stall-detector 16/16) still pass — the change is purely documentation/skill-prompt because the handoff pipeline already reads the body verbatim. Legacy `## AGENT-BRIEF` comments on existing issues are intentionally not migrated; they fall through Slice C's classifier into `## Human guidance` of the retry handoff (they look like human prose), and any new `/triage` run overrides by writing to the body.

---

## afk (engineering) — runner detection cascade, opt-in alternate + fallback

- **status**: modified
- **upstream**: —
- **why**: `/afk` historically defaulted `ALTERNATE=1`, silently rotating between `claude` and `codex` on each issue and silently swapping on `RUNNER_EXHAUSTED`. Caller intent was indistinguishable from quota loss — a Claude Code user invoking `/afk` would suddenly find Codex picking up the next issue with no visible cue. Issue #8 (parent PRD #2) replaces the default with caller-aware detection (env-var sniff → path sniff → env fallback), flips alternation to opt-in `--alternate`, and gates exhaustion-swap behind opt-in `--fallback-runner`.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: new `detect_runner` function — pure, accepts an explicit pin + optional script path, echoes `"<runner>|<method>"` so the cascade is testable in isolation. Recognises `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_CODE_SSE_PORT` (claude) and `CODEX_HOME` / `CODEX_SANDBOX` / `CODEX_SANDBOX_NETWORK_DISABLED` (codex); falls through to `*/.claude/*` vs `*/.codex/*` path sniff on `$SCRIPT_DIR`; finally `${AFK_RUNNER:-claude}`. Two new CLI flags — `--alternate` (round-robin on success) and `--fallback-runner` (swap on exhaustion) — both default off; `--alternate` is mutually exclusive with `--runner`. The exhaustion branch in `process_issue` now gates the swap on `FALLBACK_RUNNER`, not on `ALTERNATE`, so the two behaviours are decoupled. Boot log line `runner: <r> (detected via <method>)` fires once per invocation.
  - `plugins/dev/skills/engineering/afk/scripts/tests/runner-detection.test.sh`: new — 14 assertions covering pin-beats-everything, every env-var branch (both runners), both path branches, env-fallback (default and `AFK_RUNNER`), and cascade precedence (env-var beats path).
  - `plugins/dev/skills/engineering/afk/SKILL.md`: rewrote *Bootstrap* step 4 to document the cascade, added flag entries in *When To Use*, rewrote *Runner Fallback* so the new default (no rotation, no fallback) and the two opt-ins are explicit.

---

## afk (engineering) — push attempt branch to `afk-attempts/` on terminal failure

- **status**: modified
- **upstream**: —
- **why**: when an iteration ends in BLOCKED, no-sentinel, or merge-conflict, the diff used to live only on the local worker branch — after `git worktree remove` and `git branch -d` it was gone, leaving the envelope comment with no recoverable code. Issue #9 (parent PRD #2) pushes the branch to `origin/afk-attempts/{wid}/{n}-{slug}` before posting the envelope so investigators can `gh pr checkout` or follow a `compare/main...afk-attempts/...` link from the issue thread.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: new `push_attempt_branch` (SSH push to `afk-attempts/{wid}/{n}-{slug}`, returns the remote ref name or empty on failure), new `branch_diffstat_full` (adds `files=K` to the existing `+N -M`), new `build_diff_section_body` (compare-link when the push succeeded, local-worktree fallback when it failed). Wired into the three terminal-failure paths in `process_issue`; DONE path is intentionally untouched. Push failure logs a `warn:` line but never aborts the iteration.
  - `plugins/dev/skills/engineering/afk/scripts/tests/envelope-shape.test.sh`: stubs `gh_repo` + `branch_diffstat_full` so the diff-section body can be exercised hermetically. Covers both the pushed-link and push-failure-fallback shapes plus envelope-level composition under `data-section="diff"`.
  - `plugins/dev/skills/engineering/afk/SKILL.md`: replaced the "deferred to Slice B" stub with the actual behaviour (when the push runs, what the diff section contains, why DONE is exempt, the no-retention caveat).

---

## afk (engineering) — statusline aggregator + `/setup-red-skills` wiring

- **status**: modified
- **upstream**: —
- **why**: operators running `/afk` had to keep a side terminal open on `/dev:afk monitor` to know how many workers were live and what they were doing. Issue #25 (parent #16) surfaces that summary in the Claude Code statusline — `🤖 N · 📋 ready N · 🙋 human N · 🚧 blocked N · +A -B · #X #Y` — refreshed every few seconds with a cached GitHub round-trip so it stays under the ~100 ms render budget.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/statusline.sh`: opt-out now honours the brief's nested `afk: { statusline: false }` form in `.red/config.yaml` in addition to the legacy top-level `statusline: false`. Aggregator behaviour (kill-0 liveness filter, summed diffstat from `current.diff_*` fields with `git diff --shortstat origin/main` fallback, 60 s cache of `gh issue list` counts in `.red/tmp/statusline-cache.json`, async refresh on stale cache) is unchanged.
  - `plugins/dev/skills/engineering/setup-red-skills/SKILL.md`: new **Section F — `/afk` statusline** explainer + corresponding write step. The skill now (a) skips the wiring when `.red/config.yaml` declares `afk.statusline: false`, logging a one-line notice; (b) skips when `.claude/settings.json` already has a `statusLine` key, logging a one-line notice; (c) otherwise writes/merges the `statusLine` block pointing at `bash ${CLAUDE_PLUGIN_ROOT}/skills/engineering/afk/scripts/statusline.sh` with `refreshInterval: 5`.
  - `plugins/dev/skills/engineering/afk/scripts/tests/statusline.test.sh`: new test (20 assertions) — covers no-`.red/tmp` empty stdout, the one-live-worker render, two-worker summed render, dead-pid filtering, and both opt-out paths. The test pre-seeds `statusline-cache.json` so it never shells out to `gh`. Existing test suites still pass (envelope-shape 27/27, sentinel-detection 5/5, stall-detector 16/16).

---

## afk (engineering) — fleet passive stall detector + monitor `⏸️ stalled` status

- **status**: modified
- **upstream**: —
- **why**: workers stuck on silent resource contention (cargo lock, shared port, deadlocked external service) used to look identical to a healthy `🟢 live` slot in the monitor — operators only noticed when throughput dropped. Issue #23 (parent #16) adds a passive supervisor-side detector that surfaces the condition without taking any action; the operator still owns the decision to investigate / restart.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/supervisor.sh`: added the stall detector. New env knobs `STALL_THRESHOLD_SECONDS` (default `600`) and `STALL_POLL_S` (default `30`). New functions `find_slot_iter_log`, `compute_stalled` (pure predicate for unit tests), `poll_stall_detector`, and `write_supervisor_state` (replaces `write_circuit_state`, additive schema — `{"parked":[…], "stalled":[…]}`, legacy readers consuming `.parked[]?` keep working). The detector samples each non-parked slot's per-iteration `afk.log` mtime on the supervisor's main loop tick; sets `stalled:true` when both `(now − spawn_epoch) ≥ STALL_THRESHOLD_SECONDS` and `(now − log_mtime) ≥ STALL_THRESHOLD_SECONDS`; clears the flag automatically when the log advances. No `kill -TERM` / `SIGKILL` is ever sent for a stalled worker. Added a `BASH_SOURCE` guard so test harnesses can source the file without taking the singleton lock.
  - `plugins/dev/skills/engineering/afk/scripts/monitor.sh`: new `render_stalled_slots` reads `.stalled[]?` from the supervisor state file and prints one row per stalled slot: `slot-N [⏸️ stalled]  stalled for 14m  (check .red/hooks/ — possibly waiting on a shared resource)`. New `fmt_dur_human` helper (`Ns` / `Nm` / `NhMm`). `color_status` gains a `stalled` branch (magenta bold) so the status is visually distinct from `live` (green) / `stale` (yellow) / `parked` (red bold). Agent rendering contract updated with rule #7 covering the new row.
  - `SKILL.md`: Fleet Mode intro now lists the passive stall detector alongside circuit breaker and per-slot build isolation.
  - `scripts/tests/stall-detector.test.sh`: new test (16 assertions) — covers the `compute_stalled` predicate across fresh/recent/silent/no-log/spawn=0/custom-threshold branches, then drives `find_slot_iter_log` + `poll_stall_detector` against a fixture iteration directory to lock the flag/clear cycle and the JSON shape (`stalled[0].slot`, `duration_s`, `parked[]` preserved).

---

## afk (engineering) — Slice D: remove heartbeat-glyph comments from issue threads

- **status**: modified
- **upstream**: —
- **why**: periodic `:one:` / `:two:` / `:three:` / `:four:` glyph comments posted every 10 minutes from a background sub-shell were polluting issue threads and consuming `gh` quota. The thread is now timeline-only (boot stamp, attempt envelopes, human guidance, closing envelope) per the Slice D goal of issue #7 / parent #2.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: removed the heartbeat sub-shell entirely. `heartbeat_start` / `heartbeat_stop` are kept as call-site no-ops that write a single `[heartbeat] iteration started|stopped …` line to `afk.log` so forensic readers can still see iteration boundaries. Removed the `gh issue comment` heartbeat loop and the zombie-heartbeat reaper inside `prune_orphans` — there is no longer a sub-shell to kill. State init writes `heartbeat_glyph: null`, `heartbeat_pid: null` (vestigial fields, retained one release for compatibility).
  - `plugins/dev/skills/engineering/afk/scripts/monitor.sh`: dropped the `heartbeat: <glyph>` field from the per-worker compact view; liveness still derives from PID + state-file mtime.
  - `SKILL.md`: replaced the *Heartbeat Protocol* section with *Heartbeat (local-only, post-Slice-D)* describing the local-only signals; removed the heartbeat sub-shell branch from the Issue Lifecycle diagram and the *Live Header* example; reflected the change in *Per-Issue Loop* step 4, *Orphan Cleanup* step 1, *Terminal-Event Envelope* deferred-work bullets, the State File schema, and the orchestrator abort path. `SAFETY.md`, `runner-claude.md`, `runner-codex.md`: removed "kill heartbeat" language from the signal-handling, abort, and runner-exhaustion paths.

---

## afk (engineering) — structured terminal-event envelope writer + split TTL

- **status**: modified
- **upstream**: —
- **why**: every terminal event of an iteration (BLOCKED, no-sentinel, merge-conflict, DONE) now writes a deterministic `<details data-attempt-status="…">` envelope on the issue so the GitHub thread is the canonical ledger. Foundational write-side slice of issue #6 / parent #2; Slice C will parse these envelopes back.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: added `build_envelope`, `build_envelope_summary`, `emit_envelope`, `branch_diffstat`, `extract_handoff_notes`, `tail_iter_log`, `fmt_duration`; replaced the four free-form terminal comments with envelope calls; added `envelope.posted` to the per-iteration state file, set `true` after a successful POST, `false` on failure.
  - `prune_orphans` now applies a **split TTL** to preserved `ready-for-human` dirs: 1 day when `envelope.posted == true`, 7 days when `false` or missing.
  - Source-guard added so unit tests can `source` `afk.sh` without invoking the main loop.
  - `SKILL.md`: new *Terminal-Event Envelope* section; *Orphan Cleanup* updated to describe the split TTL; state-file schema gains `envelope.posted`.
  - `scripts/tests/envelope-shape.test.sh`: new test exercising summary/body shape across all four statuses + `fmt_duration` boundary cases.

---

## afk (engineering) — Fleet Mode commands in SKILL.md

- **status**: modified
- **upstream**: —
- **why**: the supervisor existed but had no user-facing entry point in the skill — operators had to know to run `bash scripts/supervisor.sh` and touch `.red/tmp/afk-supervisor.stop` by hand, and the auto-monitor cron from `/afk` was never torn down explicitly. The new `/dev:afk fleet [N]` / `/dev:afk fleet stop` section documents the launch/stop contract, the single-supervisor refusal, the Codex unsupported message, and the cron teardown handshake. Closes #4.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/SKILL.md`: new *Fleet Mode (Claude Code only — binding)* section before *Monitor* describing the two subcommands. Launch flow: runner check → PID-file pre-check → `nohup env TARGET=N bash scripts/supervisor.sh` → schedule auto-monitor cron (deduped against existing entry) → report PID, log path, stop command. Stop flow: runner check → liveness check (missing / stale / alive) → touch `.red/tmp/afk-supervisor.stop` → bounded 30s wait for PID file to disappear → `CronList`/`CronDelete` every `/dev:afk monitor` entry. Idempotency clarified — re-running stop after a clean exit is a no-op.
  - `argument-hint` frontmatter extended with `fleet [N] | fleet stop | monitor`.
  - *When To Use* gained two bullets for the new subcommands.

---

## afk (engineering) — supervisor per-slot build-isolation env vars

- **status**: modified
- **upstream**: —
- **why**: build tools that serialize on a single cache directory (cargo's `.cargo-lock`, Gradle's daemon caches, etc.) force concurrent fleet workers into 20+ minute stalls or CPU/RAM starvation when they share `/opt/cargo-target`. Per-slot subdirectories let each worker compile in isolation. The operator opts in by setting a `*_BASE` env var; non-Rust / non-Gradle projects see zero filesystem side effects.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/supervisor.sh`: new `BUILD_ISOLATION_VARS` table mapping `*_BASE` env vars to the per-worker var the supervisor exports (`CARGO_TARGET_BASE` → `CARGO_TARGET_DIR`, `GRADLE_USER_HOME_BASE` → `GRADLE_USER_HOME`). New `build_slot_env_overrides` helper computes `${BASE}/slot-{i}` for each set base var, `mkdir -p`s the directory, and emits `KEY=value` lines. `spawn_slot` collects them into an `env` argv and prefixes the worker invocation, so per-slot env never leaks into other slots or the supervisor itself. Slot indices are stable across respawns because `spawn_slot` is always called with the same slot number. Top-of-file comment documents the supported base vars and how to add a new tool.

---

## afk (engineering) — supervisor circuit breaker + monitor parked rendering

- **status**: modified
- **upstream**: —
- **why**: a misconfigured runner that fast-fails workers (auth broken, missing dependency, panic-on-startup) could burn cycles indefinitely — the supervisor respawned them blindly. The circuit breaker parks the slot after K=5 fast deaths inside a 90s window so other slots keep working while the operator fixes the broken runner. The monitor surfaces parked slots so the fleet shrinkage is visible.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/supervisor.sh`: per-slot fast-death ring buffer (tunable via `SUPERVISOR_FAST_DEATH_S` / `SUPERVISOR_CIRCUIT_K` / `SUPERVISOR_CIRCUIT_WINDOW_S`, defaults `30s` / `5` / `90s`). Worker death within `< FAST_DEATH_THRESHOLD_S` of spawn counts as a fast death; entries older than the window are pruned on each pass; hitting K parks the slot, logs `🔥 slot N parked after K fast deaths in 90s — fix runner & restart`, and writes `.red/tmp/afk-supervisor-circuit.json`. Parked slots are skipped in the respawn loop until the supervisor restarts; the circuit file is cleared both on shutdown and on a fresh `acquire_lock`.
  - `plugins/dev/skills/engineering/afk/scripts/monitor.sh`: new `render_parked_slots` reads the circuit JSON and emits one `slot-N [⛔ parked] fast_deaths=… last_death=…` row per parked slot in both TTY and compact modes. `[⛔ parked]` joins the existing `[live]` / `[stale]` / `[dead]` palette. Agent rendering contract updated to require surfacing parked rows verbatim with a `/dev:afk fleet stop` recommendation.

---

## afk (engineering) — monitor renders supervisor header

- **status**: modified
- **upstream**: —
- **why**: when the fleet supervisor is running, `monitor.sh` gave no indication that a fleet was up — operators had to `cat .red/tmp/afk-supervisor.pid` and `pgrep` by hand to verify. The new header surfaces supervisor state at a glance and distinguishes live from stale supervisor PID files.
- **what changed**:
  - new `render_fleet_header` function in `plugins/dev/skills/engineering/afk/scripts/monitor.sh`. Reads `.red/tmp/afk-supervisor.pid`; when the PID is alive, parses `target=N` from `afk-supervisor.log` and counts live workers by walking the latest `slot N: spawned worker pid=PID` entry per slot and probing `kill -0`. Emits `🛡️ supervisor pid=… target=N alive=M/N`.
  - stale PID file (process gone) renders `⚠️ supervisor pid=… STALE — run /dev:afk fleet stop to clean up` instead.
  - no PID file → nothing emitted; non-fleet usage is unchanged.
  - header rendered in both TTY (`render_full`) and compact (`render_compact`) modes, immediately above the 48h sparkline.

---

## afk (engineering) — fleet supervisor with respawn

- **status**: modified
- **upstream**: —
- **why**: foundational slice for PRD #1 (multi-worker `/afk` fleet on a single checkout). Until now, running N concurrent workers meant N manual `nohup afk.sh &` invocations and no respawn when one died. The supervisor lets a single process maintain `TARGET` workers, with a single-supervisor lock so accidental double-launches are refused.
- **what changed**:
  - new `plugins/dev/skills/engineering/afk/scripts/supervisor.sh`. Spawns `TARGET` (env, default `2`) `afk.sh` workers via `nohup`, redirects each to `.red/tmp/afk-supervisor-slot-N.log`, polls liveness every 15s with `kill -0`, respawns dead slots. Stagger between initial spawns is 2s.
  - single-supervisor invariant via `.red/tmp/afk-supervisor.pid`. Second invocation against a live PID refuses with a clear error and non-zero exit. Stale PID (process gone) is cleared and the new supervisor proceeds.
  - graceful shutdown on `SIGTERM` / `SIGINT` / touch of `.red/tmp/afk-supervisor.stop`: TERMs all workers, removes the stop-file if present, exits 0.
  - `afk.sh` is discovered relative to `$BASH_SOURCE`, so plugin upgrades and worktree layouts don't break the script. Workers are unchanged — same claim-lock, same state files, same per-iteration contract; the supervisor only manages process lifecycle.

---

## to-prd (engineering) — surface HITL decisions

- **status**: modified
- **upstream**: —
- **why**: PRDs blended human calls with agent synthesis under one `Implementation Decisions` heading. Once `/to-issues` slices a PRD and `/afk` picks up the children, the human's load-bearing choices become indistinguishable from agent inference — and they get lost.
- **what changed**:
  - new `## Human Decisions` section in the PRD template, sitting above `Implementation Decisions`. Each entry uses `Decision:` / `Why:` / `Alternatives considered:` (mirrors the `Why:` / `How to apply:` shape we already use in feedback memories and ADRs).
  - step 2 reinforced: every HITL call from the conversation that produced the PRD must be captured explicitly in `Human Decisions`. Not optional, not a free-form chat artifact.
  - `Implementation Decisions` remains for agent-side synthesis (module shapes, schemas, API contracts inferred from the codebase).

---

## afk (engineering) — auto-monitor loop + self-cancel

- **status**: modified
- **upstream**: —
- **why**: drainers were manually invoking `/dev:afk monitor` every few minutes to check progress, or setting up `/loop 3m /dev:afk monitor` by hand. The agent already has session-scoped cron primitives (`CronCreate` / `CronList` / `CronDelete`) — the skill can drive them automatically and free the user from babysitting.
- **what changed**:
  - new "Auto-Monitor Loop (Claude Code only — binding)" section in `afk/SKILL.md`. When `/afk` spawns a worker, the agent now also runs `CronCreate(cron="*/3 * * * *", prompt="/dev:afk monitor", recurring=true)` so the dashboard surfaces every 3 minutes for the rest of the session. Dedupe via `CronList` so a second parallel `/afk` doesn't double-schedule. Skipped for `/afk monitor` (not a spawn) and `/afk --once` (single supervised iteration). Falls back gracefully when running under Codex (no Cron tools available).
  - new "Self-Cancel" subsection in *Monitor*. Every monitor invocation — user-typed or cron-fired — counts `[live]` workers in its own rendered output. When zero live workers remain, the agent calls `CronList` / `CronDelete` to remove any `prompt == "/dev:afk monitor"` job, and appends `🛑 no live workers — auto-cancelled monitor loop` to the output. The cron is session-only, so worst case a stale cron dies with the session anyway.
  - shell scripts unchanged — `afk.sh` and `monitor.sh` can't invoke session-level tools, so the entire lifecycle lives in the skill prose the LLM reads.

---

## afk (engineering) — sentinel watchdog + polling discipline

- **status**: modified
- **upstream**: —
- **why**: production wheel-spin observed across multiple `/afk` iterations. Inner agent emits `<promise>DONE</promise>`, but a background tool call (`run_in_background pnpm test` followed by `until grep "test result" $out; do sleep 5; done` polling without a timeout) keeps the stream-json pipe open. The bg task crashed silently, the loop runs forever, the inner agent can't terminate because the tool call is still active, the orchestrator hangs in `anon_pipe_read` for hours. Manual `kill <bash-pid>` resolves it.
- **what changed**:
  - **Watchdog (defensive)** in `scripts/afk.sh`. New `kill_tree` helper (recursive pgrep + SIGTERM, 5 s grace, SIGKILL). New `run_sentinel_watchdog` background process spawned alongside every inner-agent pipeline; tails the raw stream capture for `<promise>(DONE|BLOCKED)</promise>`, then gives `WATCHDOG_GRACE_SECONDS` (default 30) for the pipeline to close. If still alive, kills the whole tree. Both `run_claude` and `run_codex` rewired to launch the pipeline in background and wait for the watchdog-managed exit. `run_codex` gains a `$raw` capture tee so the watchdog has a json stream to scan (was previously only available for claude).
  - **Polling discipline (preventive)** in `AGENT-PROMPT.md`. New binding section "Background Tasks and Polling" forbids the `until grep "test result"` pattern outright, prescribes foreground `timeout --kill-after=30 N cmd` as the default, and requires every fallback polling loop to carry a `$SECONDS`-based deadline plus a `<promise>BLOCKED</promise>` exit when the deadline trips.
  - **Docs.** New "Sentinel Watchdog" section in `afk/SKILL.md` describing the failure mode, the watchdog's grace + kill order, the env override, and the cross-reference to the prompt-side rule.

---

## urgent (engineering) + afk: urgent prepend in issue selection

- **status**: added (skill) + modified (afk)
- **upstream**: —
- **why**: needed a "do this now" lane that does not depend on `/triage` or the standard priority labels. `priority:high` already saturates from time to time and an urgent fix shouldn't have to wait its turn behind other high-priority work. Adds a budget label users spend sparingly.
- **what changed**:
  - new `skills/engineering/urgent/SKILL.md` with a two-question interview (what's urgent / why now), pushback rule when "why now" is weak (suggest `/report-bug` or `/triage` instead), and `gh issue create --label priority:urgent --label ready-for-agent`. Skips `needs-triage` by design. Auto-creates the `priority:urgent` label if it does not exist (colour `B91C1C`).
  - `scripts/engineering/afk/scripts/afk.sh` `select_issues`: splits the candidate pool into urgent / non-urgent, applies `--prd` / `--issues` only to the non-urgent remainder, then concats `[urgent (sorted by number asc)] + [filtered]` with a number-based dedupe so an urgent that also matched the filter does not appear twice.
  - `afk/SKILL.md` Issue Selection rewritten to document the urgent prepend as a hard rule that runs before any filter.
  - registered in `plugins/dev/.claude-plugin/plugin.json`, engineering bucket README, root README skill table.

---

## report-bug (engineering)

- **status**: added
- **upstream**: —
- **why**: bug capture flow was bouncing between users opening rough GitHub issues by hand (no template, missing repro / expected behaviour) and going through full `/triage` which is too heavy for the "first hand off" step. Needed a lightweight reporter that interviews the user, normalises the body, applies `type:bug` + `needs-triage`, and stops — `/triage` handles the rest.
- **what changed**:
  - new `skills/engineering/report-bug/SKILL.md`
  - frontmatter `argument-hint: "[symptom — leave empty to seed from conversation]"`
  - boot behaviour: argument → seed for "What's happening"; empty → mine conversation transcript for error messages, stack traces, recent commands, "this is weird"/"why is it doing"/"I expected … but got" phrases.
  - interview loop follows `Q##:` numbering + `Branches:` template established by `/start` and `/reflect`. Fills the issue template fields in order: what's happening, what should happen, reproduction, context (when/where/what i was doing/environment), severity.
  - filing: `gh issue create --label type:bug --label needs-triage`. Refuses to set priority, slice, or `ready-for-agent` — that's `/triage`'s contract.
  - hard rules: do not invent repro steps, do not file more than one issue per invocation, sanitise body for ANSI / secrets, route the user to `/triage` after creation but do not call it.
  - registered in `plugins/dev/.claude-plugin/plugin.json`, `plugins/dev/skills/engineering/README.md`, root `README.md` engineering table.

---

## global: Codex marketplace metadata + runner doctor

- **status**: modified
- **upstream**: —
- **why**: RedSkills already ran well in Claude Code, but Codex CLI installs could drift because the repo only shipped Claude marketplace metadata and the manual linker only targeted `~/.claude/skills`.
- **what changed**:
  - Added `.agents/plugins/marketplace.json` and `plugins/dev/.codex-plugin/plugin.json` so Codex can load the same `plugins/dev/skills/` tree natively.
  - Updated `scripts/link-skills.sh` to link stable skills into `~/.claude/skills`, `~/.agents/skills`, and `~/.codex/skills`.
  - Added `scripts/validate-install-metadata.sh` and wired it into `red-release` to catch drift between published skill directories and install manifests.
  - Added `scripts/doctor-runners.sh` to verify Claude/Codex runner flags, Codex marketplace registration, and manual symlink installs without calling a model.
  - Updated `red-release` to keep the Claude and Codex plugin versions in sync.
  - Registered the stable `misc/` skills in `plugins/dev/.claude-plugin/plugin.json`, matching the repo rules and README reference table.

---

## afk (engineering) — Claude/Codex runner compatibility

- **status**: modified
- **upstream**: —
- **why**: the shell runner already used unattended Claude permissions, but the runner documentation still described the older `acceptEdits` mode and the inner-agent prompt used Claude-style `/skill` phrasing in places that Codex also reads.
- **what changed**:
  - `runner-claude.md` now documents the actual `--permission-mode bypassPermissions` invocation and handoff path contract.
  - `AGENT-PROMPT.md` now tells inner agents to use the runner-native skill invocation style (`/skill` for Claude Code, `$skill` or installed skill lookup for Codex).

---

## red-release workflow — conventional-commit-driven semver + plugin.json sync

- **status**: modified
- **upstream**: —
- **why**: prior workflow always bumped patch and never touched `plugins/dev/.claude-plugin/plugin.json`, so the manifest `version` field drifted from the git tags and consumers had no semver signal.
- **what changed**:
  - Parses commits since the last tag for `feat!:` / `fix!:` / `BREAKING CHANGE` (major), `feat:` (minor), `fix:` (patch). No matching commits → skip release entirely.
  - Writes the new version into `plugin.json`, commits it back to `main` with `[skip release]` to avoid recursion, then tags and creates the GitHub Release.

---

## afk (engineering) — claim race fix

- **status**: modified
- **upstream**: —
- **why**: `gh issue edit --remove-label A --add-label B` is not atomic — gh resolves the new label set client-side and submits the union, so a removed-but-no-longer-present label is a silent no-op and exit code stays 0. SKILL.md previously claimed atomicity, which was false: two parallel `/afk` runners could both think they owned an issue.
- **what changed**:
  - New `claim_lock_acquire` / `claim_lock_release` helpers backed by `mkdir .red/tmp/claims/{N}/` (POSIX-atomic on a single checkout). `iter_close_success` / `iter_close_preserve` release automatically, so every terminal path (success, blocker, exhausted, SIGINT) cleans up.
  - `process_issue` now: (1) acquires the local lock, (2) pre-checks via `gh issue view --json labels` that `ready-for-agent` is present and `running` is absent, then (3) runs the existing edit. Either gate failing → release lock and skip.
  - `prune_orphans` sweeps stale claim locks at boot: any `.red/tmp/claims/{N}/pid` whose pid is dead gets reclaimed automatically.
  - Rejected the reporter-suggested post-verify (sleep + re-view): two racers both pass it because the final label state is idempotent. False confidence is worse than no check.
  - SKILL.md atomicity paragraph rewritten to document the three-layer scheme and the residual multi-clone / multi-host gap.

---

## afk + to-prd + to-issues + triage-labels — PRD guard + worktree relocation

- **status**: modified
- **upstream**: —
- **why**: two recurring failure modes in the AFK loop. (1) PRDs were being labelled `ready-for-agent` and picked up by `/afk`, which cannot implement them. (2) Each agent placed its worktree somewhere different — some used `../.workspaces/…` (sibling to repo), some inlined under the repo — causing confusion and stale directories outside the project tree.
- **what changed**:
  - **PRD guard**: new permanent label `type:prd` (applied by `/to-prd`, never removed) and new state label `needs-slicing` (applied by `/to-prd`, removed by `/to-issues` once children exist). `/to-prd` no longer applies `ready-for-agent` — that was the bug. `/afk` hard-filters `type:prd` from its candidate list and warns when one is found. `/to-issues` removes `needs-slicing` from the parent after publishing slices. Straggler check counts `needs-slicing`.
  - **Worktree relocation**: per-iteration directory now lives at `.red/tmp/work-{id}-i{N}/` inside the primary checkout (gitignored). It contains `worktree/`, `afk.pid`, `afk.log`, `afk.state.json`, `drop.md` — one self-contained unit per (worker, issue). Removed on success, preserved on blocker. Replaces the prior `../.workspaces/{repo}-{id}-{N}` sibling layout that drifted between agents.
  - `scripts/afk.sh`: worker ID generation in bootstrap, per-iteration `iter_open`/`iter_close_*` helpers, cross-iteration aggregates kept in shell vars and re-snapshotted into each per-iteration state file.
  - `scripts/monitor.sh`: globs `.red/tmp/work-*/afk.state.json` and renders one section per live iteration, marking dead `afk.pid` as `stale`.
  - `SKILL.md`, `SAFETY.md`, `AGENT-PROMPT.md`, `runner-claude.md`, `runner-codex.md`: drop file path is now `../drop.md` relative to the worktree (i.e. one level up inside the iteration directory).

---

## repo layout — marketplace + `dev` plugin

- **status**: modified (repo-wide restructure)
- **upstream**: —
- **why**: rebrand the single plugin from `red-skills` → `dev` so the marketplace can host additional sibling plugins later (`data`, `ops`, …) under the same `reddb-io/red-skills` repo
- **what changed**:
  - `skills/` → `plugins/dev/skills/` (`git mv`, history preserved)
  - `.claude-plugin/plugin.json` → `plugins/dev/.claude-plugin/plugin.json`; plugin `name` is now `dev`
  - root `.claude-plugin/marketplace.json` plugin entry now points `source: "./plugins/dev"` with name `dev`
  - install command becomes `/plugin install dev@red-skills` (was `red-skills@red-skills`) — **breaking for already-installed users; reinstall required**
  - README links, CLAUDE.md structure section, `scripts/link-skills.sh` updated for the new path

---

## triage, tdd, diagnose, to-issues (engineering) — body restructured with `<what-to-do>` / `<supporting-info>`

- **status**: modified
- **upstream**: `e74f006`
- **why**: companion to the [/start](#start-engineering--renamed-from-grill-with-docs) rewrite and the new SKILL.md body convention in `CLAUDE.md`. These four skills are long-bodied and prone to model drift (skipping repro, horizontal slicing, publishing without quizzing, hypothesising without a feedback loop). Frontloading the imperative directive and demoting reference/templates makes the core loop dominate.
- **what changed** (in each):
  - body wrapped in `<what-to-do>` (primary imperative) + `<supporting-info>` (reference, formats, templates)
  - explicit numbered steps with mandatory-gate language ("do not proceed until…")
  - hard DO/DON'T list using ✅/❌ — anti-patterns called out by name (horizontal slicing in tdd, skipping repro for bugs in triage, hypothesising without a loop in diagnose, publishing without user approval in to-issues)
  - reference docs, role tables, templates, and prose explainers moved to `<supporting-info>`

## setup-red-skills + README: RTK as recommended companion

- **status**: modified
- **upstream**: —
- **why**: long `/afk` runs (and engineering work generally) burn a large fraction of tokens on noisy CLI output — `pnpm install` progress, verbose `git status`, `gh` JSON. [RTK](https://github.com/rtk-ai/rtk) is a transparent hook-layer CLI proxy that saves 60–90% on routine dev ops with zero changes to skill code. Strong recommendation, not a hard dependency.
- **what changed**:
  - `setup-red-skills/SKILL.md`: new Section E — Token efficiency, with install command, verification steps, and the `rtk-ai/rtk` vs `reachingforthejack/rtk` name-collision warning
  - `README.md`: new "Before a long /afk run — install RTK" callout under Setup, with install one-liner and the same name-collision warning
  - skill overview list now mentions "Token efficiency" as a setup dimension

## caveman (productivity)

- **status**: removed
- **upstream**: `e74f006`
- **why**: maintainer preference — caveman mode adds noise to the maintainer's chat; the user prefers full sentences. The skill is available globally via the `caveman` plugin if anyone wants it.
- **what changed**:
  - removed `skills/productivity/caveman/`
  - de-registered from `.claude-plugin/plugin.json`, root `README.md` reference table, `skills/productivity/README.md`

## global: repo content fully translated to English

- **status**: modified (cross-cutting policy)
- **upstream**: —
- **why**: reddb.io policy — 100% of committed repo content (SKILL.md files, READMEs, CHANGES.md, CLAUDE.md, ADRs, templates, examples, workflow comments) must be in English. Keeps the skill library shareable, contributor-friendly, and consistent with upstream. User chat may stay Portuguese — the repo cannot.
- **what changed**:
  - translated to English: `CLAUDE.md`, `README.md` (root), `CHANGES.md`, `.red/CONTEXT.md`, `skills/engineering/setup-red-skills/SKILL.md` Section A explainer, all of `skills/knowledge/` (`README.md`, `wiki-init/SKILL.md`, `wiki-init/schema-template.md`, `wiki-init/index-template.md`, the four `page-template-*.md`, the two `examples/*.md`, `wiki/SKILL.md`, `wiki/REFERENCES.md`)
  - English-only rule documented in `CLAUDE.md` rules list

## global: workflow filenames prefixed `red-`

- **status**: modified
- **upstream**: —
- **why**: clear namespace for workflows shipped or owned by RedSkills, separating them from a host project's own CI workflows
- **what changed**:
  - `.github/workflows/upstream-watch.yml` → `red-upstream-watch.yml` (and `name:` field updated)
  - convention enforced going forward — see `feedback_red_workflow_prefix` memory and `setup-red-skills/workflows/` templates

## global: label naming convention (kebab-case or `prefix:value`)

- **status**: modified
- **upstream**: —
- **why**: consistent vocab makes labels easy to scan in the UI, easy to grep, and easy to filter with `gh issue list --label`. No uppercase/Camel/snake/space-separated labels.
- **what changed**:
  - `triage-labels.md` auxiliary labels: `prd-{N}` → `prd:{N}`, `HITL` → `slice:hitl`, `AFK` → `slice:afk`
  - `afk/scripts/afk.sh` PRD filter updated to match `prd:N`
  - naming convention section added to `setup-red-skills/triage-labels.md`

## setup-red-skills (engineering) — renamed from setup-redskills

- **status**: renamed-from-setup-redskills
- **upstream**: — (second internal rename; the original was `setup-matt-pocock-skills`)
- **why**: consistency with the rest of the vocab — RedSkills is logically two words (`red-` is the namespace prefix); skill, plugin, and workflows now share the same pattern (`red-skills`, `red-issues-needs-triage`, etc.)
- **what changed**:
  - directory `skills/engineering/setup-redskills` → `setup-red-skills`
  - frontmatter `name: setup-redskills` → `setup-red-skills`
  - live refs in `plugin.json`, `engineering/README.md`, `.red/CONTEXT.md`, `.red/adr/0001-*.md`, `to-prd/SKILL.md`, `to-issues/SKILL.md`, `triage/SKILL.md`, `afk/SKILL.md`, `in-progress/review/SKILL.md`, `wiki-init/SKILL.md`
  - historical entries in `CHANGES.md` preserved with the old name (they document the past)

## setup-red-skills: workflows shipped to consumer repos (auto-triage)

- **status**: modified
- **upstream**: `e74f006`
- **why**: close the "lost issue" gap — issues created outside the `/to-issues` flow arrive unlabelled and stay invisible to `/triage` and `/afk` (which filters on `ready-for-agent`). The workflow auto-applies `needs-triage` to every `opened`/`reopened` issue with no labels.
- **what changed**:
  - new `skills/engineering/setup-red-skills/workflows/red-issues-needs-triage.yml` (template installed into `.github/workflows/` of the consumer repo)
  - `setup-red-skills/SKILL.md`: new Section D — Workflows; step 4 copies `workflows/red-*.yml` into `.github/workflows/`; creates the `needs-triage` label if missing
  - convention: all workflows shipped by RedSkills use the `red-` filename prefix (clear namespace vs the consumer project's own CI)

## setup-red-skills: canonical lifecycle + priorities high/low

- **status**: modified
- **upstream**: `e74f006`
- **why**: `setup-red-skills/triage-labels.md` is the single source of truth for the label vocab — added a full lifecycle (ASCII state machine), the `running` label (consumed only by `/afk`), the heartbeat protocol, and auxiliary labels (`bug`, `enhancement`, `priority:high|low`, `prd:N`, `slice:hitl`, `slice:afk`). `/afk` SKILL.md references the canonical doc and only shows its own slice. Priorities reduced to two (`high`/`low`) — less hesitation in triage.
- **what changed**:
  - `setup-red-skills/triage-labels.md`: rewritten with mapping table + ASCII state machine + state definitions + heartbeat protocol + auxiliary labels + naming convention note
  - `afk/SKILL.md`: new section "Issue Lifecycle (the `/afk` slice)" with a focused diagram; references the canonical doc
  - `afk/scripts/afk.sh`: `cleanup()` on SIGINT/SIGTERM now releases the claim (`running` → `ready-for-agent`) and posts a comment; issue sort simplified to `priority:high` before the rest; PRD filter now looks for `prd:N` label instead of `prd-N`

## afk (engineering, new skill, original to reddb.io)

- **status**: added
- **upstream**: —
- **why**: we needed a single autonomous entry point that: (1) integrates with GitHub Issues (label `ready-for-agent`), (2) runs in isolated worktrees so it never touches the primary checkout, (3) coordinates state via labels + comments + heartbeat, (4) alternates runners (claude/codex) on rate-limit, (5) delivers responsive feedback (live header + monitor + state file).
- **what changed**:
  - new `skills/engineering/afk/` with `SKILL.md`, `AGENT-PROMPT.md`, `SAFETY.md`, `runner-claude.md`, `runner-codex.md`
  - `scripts/afk.sh` (main loop), `scripts/once.sh` (debug single iteration), `scripts/monitor.sh` (readonly state board)
  - filters: `--prd N`, `--issues N,N,N`, default = all `ready-for-agent`; flags `--runner`, `-n`, `--once`
  - drop file format follows the `handoff` style in `.red/tmp/drop-{N}-{slug}.md` (gitignored); references over duplication
  - atomic state file at `.red/tmp/afk-state.json`; monitor reads, orchestrator writes
  - heartbeat sub-shell `:one:` → `:four:` every 10 min via `gh issue comment`
  - merge-back with auto-snapshot when primary is dirty; conflict = `ready-for-human`, worktree preserved
  - runner exhaustion → automatic mid-issue swap; both exhausted → exit 75
  - straggler check at startup: warns about unlabelled / `needs-triage` / `needs-info` issues and (on a TTY) prompts before draining
  - registered in `plugin.json` and `README.md`

## knowledge/ (new bucket) + wiki-init + wiki (new skills, original to reddb.io)

- **status**: added
- **upstream**: — (not from Matt; Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern)
- **why**: bring an incremental, LLM-maintained knowledge accumulation pattern into RedSkills, distinct from RAG and from the technical glossary (`.red/CONTEXT.md`)
- **what changed**:
  - new bucket `skills/knowledge/` with `README.md`
  - `skills/knowledge/wiki-init/` — bootstrap (SKILL.md, schema-template.md, index-template.md, 4 page templates, 2 examples under `examples/`)
  - `skills/knowledge/wiki/` — operations (SKILL.md, REFERENCES.md with Karpathy/Memex/Tolkien Gateway/qmd/Obsidian Dataview/Web Clipper/Zettelkasten)
  - policies: layout `.red/wiki/{raw,pages,index.md,log.md}` + schema at `.red/agents/wiki.md`; kebab-case names; frontmatter `title/type/tags/created/updated/sources`; `.red/wiki/` 100% gitignored; isolated from CONTEXT/ADR; search via index+grep with future migration to qmd
  - registered in `.claude-plugin/plugin.json`, root `README.md`, and `CLAUDE.md`
  - **C4 diagram (complexity-gated)**: optional `.red/wiki/C4.md` holds the system's C4 model (Context / Container / Component, level 4 omitted). Wiki proposes creation when ≥3 services or non-trivial integration appears during ingest or query. Ingest workflow adds step 6 "C4 awareness" — check whether the new source introduces architectural surface not yet on the diagram, update if so and bump `updated:`. Lint gains check #7 "C4 staleness" — flag when sources newer than the diagram's `updated:` touch named containers/components. Mermaid blocks use plain `flowchart` (universally rendered) instead of experimental `C4Context`/`C4Container`/`C4Component`. The content around each diagram (actors, containers, components, relationships, tech choices) is the substance — the diagram is just the index — and every named element must already exist in `.red/CONTEXT.md`; new terms surface a glossary update before going into C4.md.

## reflect (productivity) — renamed from grill-me

- **status**: renamed-from-grill-me
- **upstream**: `e74f006`
- **why**: reddb.io vocab — "reflect" conveys intent without the aggressive tone of "grill"
- **what changed**:
  - directory `skills/productivity/grill-me` → `reflect`
  - `name:` frontmatter → `reflect`; description adjusted (trigger "reflect" instead of "grill me")
  - refs in `plugin.json`, `README.md`, `skills/productivity/README.md`, `skills/engineering/triage/SKILL.md`, `skills/engineering/improve-codebase-architecture/SKILL.md`, etc.

## start (engineering) — renamed from grill-with-docs

- **status**: renamed-from-grill-with-docs
- **upstream**: `e74f006`
- **why**: reddb.io vocab — this is the kickoff skill for any non-trivial work
- **what changed**:
  - directory `skills/engineering/grill-with-docs` → `start`
  - `name:` frontmatter → `start`
  - refs in `plugin.json`, `README.md`, `skills/engineering/README.md`, `improve-codebase-architecture/SKILL.md`, `triage/SKILL.md`, `setup-redskills/domain.md`, etc.
  - body rewrite (tags kept as `<what-to-do>` / `<supporting-info>`): frontloaded an explicit loop, hard DO/DON'T list, and a question-format template so the interview behaviour dominates over the documentation side-effects. CONTEXT/ADR rules demoted to "trigger" subsections instead of equal-weight tasks (model was drifting into docs mode instead of grilling).
  - **input contract**: added `argument-hint: "[plan to grill: prose, URL, path, or empty]"` so users see in autocomplete that the skill accepts a plan/context payload. Empty arg opens with `Q01: what plan are we grilling?`.
  - **eager wiki ingest**: external refs (URL / file path) in the boot argument *or* mid-grilling delegate to `/wiki ingest <ref>`. Receipt line on turn 1 (`Fetched … → wiki/raw/<slug>.md`) gives the user visibility that the material was actually read. When `/wiki` is not initialised, prompts once for `/wiki-init`; on decline, falls back to plain `WebFetch`/`Read` with receipt marked `(not cached)`.
  - **question numbering**: every question is prefixed `Q##:` (zero-padded, session-scoped, reset on each `/start`). Gives the user a sense of grilling depth and a stable handle for later reference.
  - **enumerated branches**: question template now requests a `Branches:` block with `(a)/(b)/(c)` options whenever the decision space is finite, and `Recommend:` references a branch letter (`Recommend: (a), because …`) instead of restating prose. Lets the user answer with a stable handle (`ok (b)`, `(c) but with X tweak`) and forces the skill to make the choice space explicit instead of hand-waving. Branches block is opt-out for genuinely open-ended questions.

## global: GitHub Issues as the only supported tracker

- **status**: modified (cross-cutting policy)
- **upstream**: `e74f006`
- **why**: reddb.io policy — issues and PRDs always on GitHub, never local; removes branching for local-markdown, GitLab, Jira, Linear
- **what changed**:
  - removed `skills/engineering/setup-redskills/issue-tracker-local.md` and `issue-tracker-gitlab.md`
  - `setup-redskills/SKILL.md` Section A rewritten: GitHub only, no "Local markdown" / "GitLab" / "Other"; explorer no longer looks for `.red/scratch/`
  - `setup-redskills` description and overview updated
  - `skills/in-progress/review/SKILL.md` step 2: removed refs to `GitLab !67` and `.red/scratch/`

## global: `.red/` namespace for artefacts in consumer repos

- **status**: modified (cross-cutting)
- **upstream**: `e74f006`
- **why**: keep client repos clean and identifiable — every artefact produced or consumed by RedSkills lives under `.red/` rather than polluting the root with `CONTEXT.md`, `docs/adr/`, `docs/agents/`, `.scratch/`
- **what changed**:
  - `CONTEXT.md` → `.red/CONTEXT.md`
  - `CONTEXT-MAP.md` → `.red/CONTEXT-MAP.md`
  - `docs/adr/` → `.red/adr/`
  - `docs/agents/` → `.red/agents/`
  - `.scratch/` → `.red/scratch/`
  - applied across every skill in `engineering/`, `in-progress/`, and the root files (`CLAUDE.md`, `README.md`, this repo's own `CONTEXT.md` and `docs/adr/`)

## setup-redskills (engineering)

- **status**: renamed-from-setup-matt-pocock-skills
- **upstream**: `e74f006`
- **why**: Matt's name doesn't fit a plugin called `redskills`
- **what changed**:
  - directory `skills/engineering/setup-matt-pocock-skills` → `setup-redskills`
  - heading `# Setup Matt Pocock's Skills` → `# Setup RedSkills`
  - references in `to-prd`, `to-issues`, `triage`, `review`, `engineering/README.md`, `docs/adr/0001-*.md` updated

## deprecated/ (bucket)

- **status**: removed
- **upstream**: `e74f006`
- **why**: reddb.io decision not to ship dead skills
- **what changed**: removed all of `skills/deprecated/` (ubiquitous-language, qa, design-an-interface, request-refactor-plan)

## personal/ (bucket)

- **status**: removed
- **upstream**: `e74f006`
- **why**: skills tied to Matt's personal setup, not applicable to reddb.io
- **what changed**: removed all of `skills/personal/` (edit-article, obsidian-vault)
