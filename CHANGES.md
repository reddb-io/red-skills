# CHANGES — Divergences from upstream

Records every change made to skills inherited from [`mattpocock/skills`](https://github.com/mattpocock/skills), plus new skills created by reddb.io. See the rules in [CLAUDE.md](./CLAUDE.md).

Upstream base: `mattpocock/skills@b8be62ffacb0118fa3eaa29a0923c87c8c11985c` (see `.upstream`).

---

## curate (engineering) — `--background` non-interactive issue filer (modified)

- **status**: modified
- **upstream**: —
- **why**: Issue #94 (PRD #91). Phase 2 of the consent contract: a non-interactive entry point that **never mutates a Skill file** and instead surfaces the same Curatable-skill candidates as a `ready-for-human` Issue. The interactive `/curate` path (or `/afk` against the filed issue) closes the loop later via the existing archive-engine — no new mutation surface is introduced.
- **what changed**: New thin module `plugins/memory/src/curate-skill/issue-filer.ts` — `renderIssueTitle`, `renderIssueBody`, and `fileBackgroundIssue` (the only side effect: shells out to `gh issue create --label ready-for-human --body-file`). Per the slice brief, no dedicated unit test; matches the project's treatment of other `gh`-boundary modules. New `background` subcommand in `plugins/memory/src/curate-skill/cli.ts` — runs the same `precheck` as `list` (so the telemetry-not-enabled prerequisite message is identical to the interactive path), reads `memory curate skills --json`, applies the same `candidate-reader` filtering, and: (a) if the candidate list is empty, exits 0 with **zero outward action** (no issue filed, no comment, no noise), (b) otherwise files **exactly one** Issue grouping candidates by category in the same `stale` → `abandoned` → `frequently-failing` → `archive` order as the interactive view, reusing the glossary vocabulary and per-category evidence string verbatim. `--background` performs zero filesystem mutations of any Skill file under any input — it never invokes `archive` or `restore`. The slice does not introduce a new label vocabulary; it reuses `ready-for-human` as defined by `/setup-red-skills`. SKILL.md gains the `--background` mode section + invocation example; the argument hint advertises the flag. Refs #94.

## curate (engineering) — interactive, archive-only Skill curator (added)

- **status**: added
- **upstream**: —
- **why**: Issue #92 (PRD #91). Tracer slice for the **mutating** Skill curator. Memory's report-only `memory curate skills` surfaces archive recommendations; `/curate` is the user-facing workflow that turns approved Curatable-skill `archive` recommendations into recoverable filesystem moves.
- **what changed**: New skill `plugins/dev/skills/engineering/curate/SKILL.md` — boots with `red-curate-skill check` (fails fast with the exact `memory init --mode graph --skill-telemetry` command when Skill telemetry is off), lists `archive` candidates via the workflow CLI, requires explicit per-name approval, and archives approved Curatable skills via atomic `rename` + per-file SHA-256 manifest. `--restore <name>` reverses the move and hash-verifies every restored file. Three pure modules (`candidate-reader`, `archive-engine`, `consent-gate`) plus the workflow CLI live under `plugins/memory/src/curate-skill/` to share the Memory plugin's tsx / vitest toolchain — the **workflow** itself (and the only entry point that performs the mutation) is the dev-plugin skill, so CONTEXT.md's "skill mutation is a workflow outside the Memory plugin" rule is honoured at the workflow level; the `memory` CLI never invokes archive or restore. The archive engine has a non-destructive `ArchiveFs` interface (no `unlink`/`rm`/`rmdir` member) and is gated by `validateCandidate` so `source_kind` `plugin`/`hub` and `pinned` candidates are refused with a structured rejection *before* any I/O. New bin `red-curate-skill` (`plugins/memory/package.json`). Tests in `plugins/memory/tests/curate-skill.test.ts` cover all three pure modules, the validation gate (no-I/O proof via probing the archive base), a round-trip archive → restore with hash verification, a trip-wire facade proving the engine never reads a destructive fs method, and CLI precondition / empty-approval no-mutation cases. Registered in `plugins/dev/.claude-plugin/plugin.json` (`./skills/engineering/curate`), root `README.md`, and `plugins/dev/skills/engineering/README.md`. Codex's `plugins/dev/.codex-plugin/plugin.json` auto-includes the new directory via `"skills": "./skills/"`. Refs #92.

## afk, triage, diagnose (engineering) — soft-use the `memory` plugin (modified)

- **status**: modified
- **upstream**: afk `—`; triage `e74f006`; diagnose `e74f006`
- **why**: Issue #57 (PRD #49). The `memory` plugin lives on top of `dev` to improve its processes — `/afk` recalling prior attempts/known fixes, `/triage` deduping against known problems, `/diagnose` surfacing past root causes. The integrations had to be wired without making `dev` depend on `memory`: the dependency stays one-directional (`memory` hard-requires `dev`; `dev` only soft-uses `memory`), and all three skills must behave exactly as today when `memory` is absent.
- **what changed**: New shared bridge `plugins/dev/scripts/memory-bridge.sh` — `memory_available <root>` (two gates: `.red/memory/config.json` opt-in **and** a resolvable CLI via `$RED_MEMORY_CLI` → `memory` on PATH → sibling-plugin `dist/cli.js` → in-repo `$MEMORY_REPO_ROOT`) and `memory_recall <root> <query…>` (prints a ranked context block or nothing, **always exits 0** — a missing/uninitialized/erroring memory is an absent optimization, never a failure of the calling dev process). `/afk` AGENT-PROMPT.md Workflow step 1 (Read) recalls before planning; `/triage` Flow B step 1 (Gather context) dedupes recalled known-problems into the Recommend step; `/diagnose` recalls past root causes at the top of Phase 3 (Hypothesise) and stores the new root cause in Phase 6 — each gated, best-effort, silent when `memory` is absent. `dev`'s `plugin.json` deliberately does **not** list `memory` (one-directional guarantee enforced by absence). New `plugins/dev/scripts/tests/memory-bridge.test.sh` (17 assertions: resolution cascade, both detection gates, graceful no-op when absent/uninitialized/erroring, query passthrough) — green. ADR 0009 records the soft-use contract; CONTEXT.md notes the direction on the **Memory plugin** term. Refs #57.

## git-guardrails-claude-code (misc) — make the hook branch-lock aware (modified)

- **status**: modified
- **upstream**: `b8be62f`
- **why**: Issue #65 (PRD #59). The lock was only enforced by the `branch-lock` skill's own hook. A repo running `git-guardrails-claude-code` alone (a common setup) got no lock protection, and ADR 0006 anticipated making git-guardrails lock-aware so either skill enforces the lock. The two had to stay independent — neither importing the other — with an idempotent overlap when both are installed.
- **what changed**: `scripts/block-dangerous-git.sh` gains a second, self-contained layer after the always-on dangerous-pattern block. When an opt-in `./.red/tmp/branch-lock.yaml` is present in the primary checkout, the hook also blocks the branch-leaving / work-loss family — `git switch`/`checkout` to another branch, `switch -`, `checkout -b <new>`, and bare `git stash` — while allowing a switch back to the lock target, targeted file restore (`git checkout -- <path>`), and `git worktree add`. It reads the lock file, resolves scope, and classifies the command **inline** (token-stream scan, compound-command aware), reaching the same verdicts as the branch-lock classifier but **without sourcing or requiring** the `branch-lock` skill (AC3 — no dependency). `/afk` worktrees under `.red/tmp/work-*/` are scope-exempt, mirroring the branch-lock hook so the autonomous loop is never strangled. Absent lock file = silent (opt-in). With both hooks installed the overlap is idempotent: both deny the same commands, neither conflicts (AC2). New `scripts/tests/block-dangerous-git.test.sh` (24 assertions: unchanged dangerous patterns, lock-active branch-leaving/work-loss blocks, same-branch allows, worktree scope exemption, and a no-dependency guard) — green; full branch-lock suite still green (cli 12, classifier 41, lock-store 17, scope-resolver 8, session-start 14). SKILL.md documents the new layer and the no-dependency contract. Refs #65.

## afk (engineering) — honour a PRD/issue pinned branch for base + merge (modified)

- **status**: modified
- **upstream**: —
- **why**: Issue #64 (PRD #59). `/afk` always based worktrees on `origin/main` and merged back into `main`. Work items that target a long-lived feature branch had no way to declare it, so every slice landed on `main` and a human had to move it.
- **what changed**: New pure module `scripts/lib/pin-reader.sh` — `pin_parse_branch` (canonical `branch:` line, list-marker/backtick/quote tolerant, prose-safe), `pin_parse_parent_prd` (`PRD #N` from the `## Parent` convention), and `pin_resolve` (inheritance chain: issue's own pin → parent PRD's pin → `main`). `afk.sh` sources it and adds `resolve_pinned_branch`, the only side effect (fetches the parent PRD body over `gh` only when the issue carries no pin). `process_issue` resolves the pinned branch and bases the worktree on `origin/{pinned}`; `do_merge` gains a `target` param and, when the target is not `main`, switches the primary checkout onto it for the merge/push and **restores `main` on every exit path** (success, conflict-abort, push-reject, hook-abort) so the startup precheck invariant holds. `merge_resolve_conflict` takes the target so its prompt names the right branch. No-pin resolves to `main`, so default behaviour is unchanged. New `scripts/tests/pin-reader.test.sh` (18 assertions: parse + reject-prose, PRD→issue inheritance with override, default-main). Full afk suite green except the pre-existing-RED `statusline.test.sh` (unrelated terminal-escape artifact). ADR 0008 records the merge-to-pinned decision; CONTEXT.md gains the **Pinned branch** term. Refs #64.

## memory plugin — graph mode: core graph-store over RedDB (core)

- **status**: added
- **upstream**: —
- **why**: Issue #52 (PRD #49). Second slice of the `memory` plugin: the RedDB-backed graph storage and the `memory init` path that builds + provisions it locally, so `/memory:store` and `/memory:recall` can run against a typed knowledge graph instead of only flat markdown. Vendors the proven `MemoryStore` from `../red-memory/packages/core` (commit `483034e`) rather than reinventing it.
- **what changed**: Ported `schema.ts` (collections, node/edge taxonomy) and `hash.ts` (content dedupe hash) into `plugins/memory/src/`. New `graph-store.ts` — a `MemoryStore` facade over `@reddb-io/sdk` connecting to a per-project `file://` store: idempotent collection bootstrap, `upsertNode`/`upsertEdge` with KV-backed dedupe, `supersede` (creates a `SUPERSEDED_BY` edge + head-of-chain KV marker), and read paths (`listNodes`, `getNode`, `neighborhood`, `stats`). Writes go through multi-model DML (`INSERT … NODE/EDGE`) and dedupe lives in KV per **ADR 0007** — graph collections reject table inserts and `WHERE`-filter only on `label`/`node_type`, so reads that need rid/content scan client-side. New `graph-recall.ts` — term-scan seeding (FTS over graph properties is unavailable in this engine build) + one-hop neighborhood expansion, dropping superseded nodes. `config.ts` gains `storePath` + `resolveStoreUri`; `init.ts` gains `graphConfig`/`initGraph` (writes config, provisions the store, `reddb: true`, hooks/MCP still off); `cli.ts` routes `init --mode graph` and mode-aware `store`/`recall`. `@reddb-io/sdk` added as a dependency with `pnpm.onlyBuiltDependencies` so the postinstall fetches the bundled `red` binary; no committed `dist/`/`node_modules/`. 7 new vitest assertions against a real `file://` RedDB (CRUD, node + edge dedupe, supersede head-of-chain, init-graph config, store→recall round-trip) — 21 total green; typecheck + build clean; CLI verified end-to-end (init graph → store ×2 dedupes → recall ranks the right node). Out of slice: hybrid mode, MCP server, auto-firing hooks, and the `/afk` · `/triage` · `/diagnose` integrations.

## memory plugin — markdown-only init/store/recall (core)

- **status**: added
- **upstream**: —
- **why**: Issue #51 (PRD #49), tracer-bullet slice. First end-to-end demoable slice of the new `memory` plugin: a persistent, queryable memory for code agents that lives on top of `dev`. Original to reddb.io (ports `../red-memory`); markdown-only is the low-risk path that works with no RedDB and no graph engine.
- **what changed**: New second plugin `plugins/memory/`, mirroring the `dev` layout (`.claude-plugin/plugin.json` + `.codex-plugin/plugin.json` + `skills/<bucket>/SKILL.md`), registered in both marketplace manifests and declaring a hard dependency on `dev`. Self-contained nested TS workspace under `plugins/memory/` (own `package.json`, `tsconfig`, `pnpm-workspace.yaml`, vitest); `dist/`/`node_modules/` gitignored and built at init time. Five small modules with explicit-args, side-effect-free cores: `config.ts` (read/write `.red/memory/config.json`), `init.ts` (markdown-only wizard path — hooks off, MCP off, RedDB not required), `store.ts` (write a fact as a markdown note), `recall.ts` (FTS over the notes, ranked), `cli.ts` (`memory init|store|recall`). Three skills under `skills/core/`: `/memory:init`, `/memory:store`, `/memory:recall`. 14 vitest assertions across init-wizard, recall, and the init→store→recall round-trip — all green; typecheck and build clean; CLI verified end-to-end. `scripts/validate-install-metadata.sh` generalized to validate both `dev` and `memory` (skill-list sync, Claude/Codex version + name parity, both marketplaces expose the plugin, memory declares the `dev` dependency). Out of slice (later PRD #49 work): graph/hybrid storage over RedDB, the MCP server, the auto-firing hooks (SessionStart/PostToolUse/Stop/PreCompact), and the `/afk` · `/triage` · `/diagnose` integrations.

## branch-lock (misc) — change the lock anytime (atomic relock-then-switch)

- **status**: modified
- **upstream**: —
- **why**: Issue #63 (PRD #59). The user must be able to move the lock to another branch at any time without the hook blocking the very move they asked for. `branch-lock.sh set` already did the atomic relock-then-switch (rewrite the target first, then `git switch`), but nothing pinned that contract down — a future refactor could reorder the two steps and silently reintroduce the deadlock.
- **what changed**: New `branch-lock-cli.test.sh` (12 assertions) drives `branch-lock.sh` end-to-end against throwaway repos and locks in the three acceptance criteria: AC1 — `set <new>` from another branch rewrites the lock target *and* lands the working tree on the new branch in one step; AC2 — the intended move is never hook-blocked, proven by showing a raw `git switch <new>` is blocked while the lock still points at the old branch yet `set <new>` succeeds anyway (it relocks first), and that the post-relock state lets the hook allow the very switch the CLI just made; AC3 — locking to the branch already checked out just rewrites the target with no switch. No production code changed — the behavior was already correct; this is a regression guard. Full branch-lock suite green (cli 12, classifier 41, lock-store 17, scope-resolver 8, session-start 14). SKILL.md layout updated to list the new test.

## branch-lock (misc) — SessionStart prompt to offer locking the current branch

- **status**: modified
- **upstream**: —
- **why**: Issue #62 (PRD #59). The lock was opt-in but invisible: nothing reminded the agent the protection existed, so a session would run unlocked unless the user happened to remember `/branch-lock`. This makes the offer the agent's first action.
- **what changed**: New self-contained `branch-lock-session-start.sh` SessionStart hook reusing the same two pure modules as the PreToolUse hook (`lock-store.sh`, `scope-resolver.sh`) so the prompt obeys the exact same scope rule as enforcement. It emits a SessionStart `additionalContext` block instructing the agent to ask whether to lock to the current branch (named) before doing anything else — and never writes the lock itself; a `yes` runs `branch-lock.sh set <branch>`, a `no` leaves the repo unlocked. Stays silent (exit 0, no output) inside `/afk` worktrees (scope exemption), when a lock is already present (nothing to offer), and on a detached HEAD (no branch to lock). New `session-start.test.sh` (14 assertions: should-prompt decision matrix + prompt-text content + end-to-end runs against throwaway repos for primary/locked/worktree). Full branch-lock suite green (classifier 41, lock-store 17, scope-resolver 8, session-start 14). SKILL.md layout + install steps + scope note updated.

## branch-lock (misc) — block the full work-loss git family while locked

- **status**: modified
- **upstream**: —
- **why**: Issue #61 (PRD #59). Extends the classifier so a lock protects against the whole work-losing git family, not just branch switches: a locked agent that runs `git reset --hard` or `git clean -f` would have destroyed work the lock was meant to guard.
- **what changed**: `git-command-classifier.sh` gains four new subcommand families, all gated the same way the branch-switch block already was (active lock, primary checkout — scope/lock logic unchanged in the hook). Blocks: `git stash` / `stash push` / `stash save` (bare stash defaults to push), `git clean` with any force flag (`-f`/`-fd`/`-xfd`/`--force`), `git reset --hard`, and whole-tree restore (`git checkout .`, `git checkout -- .`, `git restore .`). Allows the non-destructive members of each family — read-only stash (`list`/`show`), dry-run clean (`-n`/`--dry-run`), soft/mixed reset, targeted single-file restore (`git restore <path>`, mirroring the already-allowed `git checkout -- <path>`), and `--staged` unstage. The checkout scanner now walks past `--` so `git checkout -- .` is caught while `git checkout -- <path>` stays allowed. 22 new classifier assertions (41 total, all green); hook block message and SKILL.md block/allow tables + scope note updated to match.

## branch-lock (misc) — lock the agent to a branch, block switching away

- **status**: added
- **upstream**: —
- **why**: Issue #60 (PRD #59), tracer-bullet slice. First end-to-end protection of the branch-lock PRD: pin the agent to one branch in the primary checkout and stop it from quietly switching away. Original to reddb.io; extends the `git-guardrails-claude-code` hook pattern without depending on it.
- **what changed**: New skill `plugins/dev/skills/misc/branch-lock/`. Three pure shell modules following the afk `lib/` explicit-args contract — `lock-store.sh` (atomic read/write/clear of gitignored `.red/tmp/branch-lock.yaml`; absent = unlocked), `scope-resolver.sh` (enforce in the primary checkout, exempt `.red/tmp/work-*/` worktrees by toplevel location), `git-command-classifier.sh` (minimal: `git checkout`/`git switch` to a non-lock branch → block; switching back, `git checkout -- <path>`, and `git worktree add` → allow) — each with a `*.test.sh` mirroring the afk harness (lock-store 17, scope-resolver 8, classifier 19 assertions, all green). Self-contained `branch-lock-hook.sh` PreToolUse(Bash) composes the three into an allow/exit-2-block verdict with a clear message. `branch-lock.sh` CLI backs `/branch-lock set|clear|status` (atomic relock-then-switch, lock-store stays the single writer). Added ADR 0006 (agent-only enforcement) and CONTEXT.md glossary terms (Branch lock, Primary checkout, Worktree). Out of slice (later PRD #59 work): SessionStart prompt, `git stash`/`clean`/`reset --hard` blocks, PRD/issue branch pin, git-guardrails lock-awareness.

---

## code-nav (mcp) — LSP-backed code navigation server

- **status**: added
- **upstream**: —
- **why**: Acting on [*How Claude Code works in large codebases*](https://claude.com/blog/how-claude-code-works-in-large-codebases-best-practices-and-where-to-start), which calls LSP integration the high-value addition for large codebases — symbol-level navigation on top of the default agentic search, so the agent stops grepping a name and guessing which match is real.
- **what changed**: First non-skill artifact in the `dev` plugin — an MCP server under `plugins/dev/mcp/code-nav/`. A thin LSP client (`vscode-languageserver-protocol` over stdio) spawns the language server for a file's extension, runs the `initialize` handshake, opens documents lazily, and forwards five MCP tools to LSP requests: `workspace_symbols` (find by name), `goto_definition`, `find_references`, `document_symbols`, `hover`. Config-driven extension→server registry (TS/Go/Rust/Python presets, override via `CODE_NAV_SERVERS`); one server process per language, reused across calls; a missing server binary is skipped without crashing the others. Wired into the plugin via `plugins/dev/.mcp.json` (`mcpServers: "./.mcp.json"` in `plugin.json`, `${CLAUDE_PLUGIN_ROOT}` path). Shipped as a pre-bundled self-contained `dist/index.js` (esbuild) so it runs with zero install; `node_modules` is gitignored. Verified end-to-end against `rust-analyzer` on a fixture crate: all five tools returned correct semantic results (definition at the exact line, both references, full hover signature + doc comment).

---

## handoff (productivity) — redaction guidance

- **status**: modified
- **upstream**: `b8be62f`
- **why**: Issue #36 (upstream drift `67bce91...b8be62f`). Upstream added a redaction instruction to the handoff skill so secrets/PII don't leak into the handoff document.
- **what changed**: Ported only the redaction sentence ("Redact any sensitive information — API keys, passwords, tokens, or PII") into our `/handoff` SKILL.md. Skipped the upstream temp-dir wording (our skill already saves via `mktemp`, i.e. the OS temp dir), the `improve-codebase-architecture` HTML-report rewrite (large, opinionated — defer to a dedicated decision), and the `grill-with-docs/CONTEXT-FORMAT.md` cosmetic tweaks (our `/start` has diverged). Bumped `.upstream` to `b8be62f`.

---

## afk (engineering) — extract lib/history.sh as a deep Module

- **status**: modified
- **upstream**: —
- **why**: Issue #48 (PRD #46). The History ledger (`afk-history.jsonl`, the throughput record the monitor sparkline reads) had its `flock`-serialised append/trim defined in `afk.sh` while `monitor.sh` re-derived the JSONL read schema inline in its own `jq` filter. The wire shape lived in two places — exactly the drift a deep Module prevents.
- **what changed**: Added `scripts/lib/history.sh` following the pure / explicit-args contract of `lib/state.sh` and `lib/merge.sh` — reads no orchestrator globals; the ledger path is a parameter on every call. Three entry points: `history_append <path> <event> [KEY=VALUE]...` (variadic `worker`/`issue`/`runner`/`duration_s`/`merge_sha`/`reason` mirroring `state_write`, optional fields omitted from the record when empty, `flock`-serialised one-record append, JSONL schema defined exactly once in `_HISTORY_APPEND_FILTER`), `history_trim <path> [max_lines]` (`flock`-serialised cap; echoes the cap count when a trim happens so the caller can log it, silent no-op otherwise), and `history_read_done_buckets <path> <from_hour> [buckets]` (the per-hour `done` counts the 48h sparkline needs). `afk.sh`'s inline `history_append`/`history_trim` were removed; a thin `emit_history` adapter wires the Module to the orchestrator's `WORKER_ID`/`HISTORY_FILE` globals, and the six callsites now route through it. `monitor.sh`'s `render_sparkline` sources the Module and consumes `history_read_done_buckets` instead of its hand-rolled `jq` (no second copy of the read schema remains). Emitted ledger bytes are identical to pre-extraction for every event (asserted). New `scripts/tests/history-module.test.sh` (38 assertions: bucketing against a fixture ledger including ignored non-`done` events and dropped out-of-window indices, custom width, missing-file contract; append optional-field presence + numeric `issue`/`duration_s` types + round-trip through the reader; trim cap/echo/no-op) with a `tests/fixtures/history/buckets.jsonl` fixture. All existing afk suites stay green except the pre-existing-RED `statusline.test.sh` (unrelated terminal-escape artifact, `d983094`). Refs #48.

---

## afk (engineering) — extract lib/envelope.sh as a deep Module

- **status**: modified
- **upstream**: —
- **why**: Issue #47 (PRD #46). The `<details data-attempt-status="…">` Envelope schema lived twice — `afk.sh`'s `build_envelope` family and `supervisor.sh`'s hand-rolled `build_discard_envelope` — and the orchestrator carried three near-identical failure-emit blocks (push attempt branch → build diff section → post). Two definitions of one wire shape is exactly the drift a deep Module prevents.
- **what changed**: Added `scripts/lib/envelope.sh` following the pure / explicit-args contract of `lib/state.sh` and `lib/merge.sh` — reads no orchestrator globals, posts via an **injected poster callback** (no hard-wired `gh`), and never writes `envelope.posted`. The `data-attempt-status` schema is now defined exactly once in `envelope_build_body`. Two entry points: `envelope_emit_attempt` (failure family `blocked`/`no-sentinel`/`merge-conflict` **and** the supervisor's `discarded` Envelope — builds per-status sections, pushes the `afk-attempts/{worker}/{issue}-{slug}` branch on the failure path before composing the diff section, posts) and `envelope_emit_done` (section-less success Envelope, no push). `afk.sh`'s `fmt_duration`/`build_envelope_summary`/`build_envelope`/`build_diff_section_body`/`extract_handoff_notes`/`push_attempt_branch` became thin back-compat wrappers; its three failure-emit blocks collapse to one `emit_envelope` call each, and `emit_envelope` is now a Module adapter that keeps ownership of writing `envelope.posted` after a successful post. `supervisor.sh`'s `build_discard_envelope` composes through `envelope_build_body`, and its sweep posts through `envelope_emit_attempt` (second adapter on the same builder). Emitted bytes are identical to pre-extraction for every status (asserted in tests). New `scripts/tests/envelope-module.test.sh` (45 assertions: per-status section ordering, push-success/fail diff bodies, discarded + done shapes, byte-for-byte equality vs `envelope_build_body`, poster-rc propagation) with the post stubbed to a capturing no-op. Existing `envelope-shape.test.sh` (37) and `trip-sweep.test.sh` (39) stay green unchanged. Refs #47.

---

## afk (engineering) — Task mirror Codex sink (native primitive or monitor.sh fallback)

- **status**: modified
- **upstream**: —
- **why**: Issue #45 (PRD #42, ADR `0003`). The native Task mirror is runner-specific, mirroring the `runner-claude.md` / `runner-codex.md` split. #43 shipped the Claude sink (agent-driven `TaskCreate`/`TaskUpdate` consuming `mirror_plan`); a Codex session had no mirror at all and silently fell through. ADR 0003 requires an explicit per-runner adapter — no cross-runner abstraction.
- **what changed**: Added the Codex sink to `scripts/lib/mirror.sh` — `mirror_sink_codex <root> [tracked]` plus its single mockable capability probe `codex_native_task_available` (returns non-zero today; Codex ships no native task surface). Native-available route emits the **same `mirror_plan` call descriptors** the Claude sink applies (reader + reconciler reused unchanged, not reimplemented); no-primitive route falls back to the `monitor.sh` dashboard and prints one notice line, swallowing a `monitor.sh` hiccup so the tick never crashes and emitting zero native calls (no half-state). Always returns 0 (clean degrade). SKILL.md *Task Mirror* gains a binding *Codex sink* paragraph (bare-terminal still skips silently; Codex now falls back rather than skipping); `runner-codex.md` gains a *Task Mirror Sink* section. New `scripts/tests/mirror-codex-sink.test.sh` (11 assertions: default no-primitive, fallback exits 0 + one notice + no half-state, native-mock emits a TaskCreate per live worker and matches `mirror_plan` byte-for-byte, empty-root fallback). No change to `afk.sh`, `monitor.sh`, or the reader/reconciler. Refs #45.

---

## afk (engineering) — Task mirror re-hydrates native tasks on session reopen

- **status**: modified
- **upstream**: —
- **why**: Issue #44 (PRD #42, ADR `0003`). A native task dies with the Claude Code session but the `nohup` AFK worker does not, so a reopened session showed no per-worker tasks until the operator acted. The status bar must recover them automatically.
- **what changed**: No new code path — re-hydration *is* `mirror_plan` (from #43) running cold: on reopen `TaskList` returns no mirror-owned tasks, so the tracked set is empty and the reconciler emits an all-`create` plan over the live state files. Added a *Re-hydration on session reopen* note to the SKILL.md Task Mirror subsection making the contract binding (only `afk.pid`-alive workers re-hydrate; dead workers are untracked-terminal on a cold tick → no ghost task; the next tick is idempotent). Added a 3-assertion re-hydration family to `scripts/tests/mirror.test.sh` (30 total) verifying: reopen recreates each live worker task, dead worker yields no ghost, second tick produces no duplicates. No change to `mirror.sh`, `afk.sh`, or `monitor.sh`. Refs #44.

---

## afk (engineering) — native Task mirror surfaces live workers as background tasks

- **status**: modified
- **upstream**: —
- **why**: Issue #43 (PRD #42). A `/afk` session under Claude Code had only the textual `monitor.sh` dashboard; live workers weren't reflected onto the runner's native task surface, so the user had to keep typing `monitor` to see progress.
- **what changed**: New pure module `scripts/lib/mirror.sh` with three layers — `mirror_read_workers` (state-reader: globs `.red/tmp/work-*/afk.state.json`, verifies liveness via the sibling `afk.pid` with `kill -0`, emits one normalized JSONL record per worker that maps to a task, marking dead-but-named iterations `gone`); `mirror_reconcile` (pure diff keyed by `worker_id:issue` → `create`/`update`/`complete` ops, idempotent across ticks); and `mirror_plan` (maps ops to `TaskCreate`/`TaskUpdate` harness-call descriptors at a single mockable boundary). SKILL.md gains a *Task Mirror (Claude Code only — binding)* subsection under Monitor wiring the sink onto the existing every-3-min `/dev:afk monitor` tick (Codex skips silently). New `scripts/tests/mirror.test.sh` (27 assertions: reader live/dead/idle/partial-state/multi-worker; reconciler cold/advance/idempotent/terminal/drop; plan title+stage mapping and read-only invariant). No change to `afk.sh` orchestration or `monitor.sh`. Refs #43.

---

## afk (engineering) — merge stage integrates moved origin/main, rolls back rejected pushes, dispatches conflict resolver

- **status**: modified
- **upstream**: —
- **why**: Issue #37. `do_merge` fetched `origin/main` but never integrated it, so worker branches merged onto the stale boot-time HEAD and every push was rejected non-fast-forward once origin moved mid-run; the rejected push left an orphan merge commit on local main; and the documented one-shot conflict resolver (SKILL.md per-issue loop step 8) was never implemented (`"no inner self-resolve yet"`).
- **what changed**: New `lib/merge.sh` with two pure git primitives — `merge_integrate_origin` (fast-forward local main onto a moved `origin/main`, or rebase a divergent local snapshot onto it) and `merge_rollback` (reset the checked-out branch to the captured pre-merge tip). `afk.sh` `do_merge` now integrates before merging, captures `pre_merge_sha`, rolls back on push rejection, and on conflict dispatches `merge_resolve_conflict` — a one-shot inner-agent resolver re-entered in the primary checkout with the conflict diff + `git status`, resolving iff no unmerged paths and no `MERGE_HEAD` remain, else falling back to `git merge --abort`. SKILL.md step 8/9 rewritten to match. New `scripts/tests/merge-integrate.test.sh` (19 assertions over temp git repos with a local bare origin: fast-forward integration, divergent rebase, push-rejection rollback, in-sync no-op, missing-ref failure). Out of scope per the issue: supervisor-level fleet coordination. Refs #37.

---

## afk (engineering) — SKILL.md handoff template + README directive-writing docs

- **status**: modified
- **upstream**: —
- **why**: PRD #29 Track A. The two-channel handoff builder (#31) and precedence ladder (#33) shipped, but the operator-facing docs still described the four-element handoff and the old `<human-guidance>` semantics. Operators had no documented way to learn the `<details data-kind="directive">` marker syntax or the authority hierarchy.
- **what changed**: `SKILL.md` *Handoff File Template* now shows the `<thread-discussion>` element in correct position (between `<human-guidance-thread>` and `<agent-notes>`, with `<thread-discussion-entry>` children) and documents the new `<human-guidance>` semantics (one element per extracted directive; two markers in one comment → two siblings). The file-table `handoff.md` row enumerates all five wrappers. Root `README.md` gains a new *Steering a worker mid-flight — directive markers* subsection under `/afk` with a copy-pasteable `<details data-kind="directive">` example, the marker-is-the-authority-gate explanation, and the four-rung precedence ladder summary (`<human-guidance>` > `<issue-body>` > `<previous-attempts>` > `<thread-discussion>`). Docs-only — no script or test change. Refs #34.

---

## afk (engineering) — comment classifier + directive extractor (deep modules)

- **status**: modified
- **upstream**: —
- **why**: PRD #29 #30. Both downstream tracks (A1 directive routing, B1 cap state machine) need a single source of truth for "what kind of comment is this" and "what directives does it carry". Today the predicates are scattered (`envelope_is_envelope`, `comment_is_boot_stamp`, `comment_is_promotion_audit`, `comment_is_heartbeat_glyph`) and directive detection is a private substring peek.
- **what changed**: `afk.sh` gains two pure functions — `classify_comment(body)` returning `envelope` | `directive_carrier` | `thread_discussion` | `audit_noise` (composes the legacy predicates, adds the `directive_carrier` arm, deferring well-formedness to `extract_directives` so the two can never disagree), and `extract_directives(body)` emitting the verbatim content of every well-formed `<details data-kind="directive">…</details>` element NUL-separated in document order (line-oriented parser handling nesting, fenced-code-block `</details>`, attributed/unterminated malformed closes, and CRLF). The legacy predicates stay in place this slice; A1/B1 migrate callers later. New `comment-classifier.test.sh` (26 assertions, no stubs — proving purity). Refs #30.

---

## afk (engineering) — per-issue cap trip handler + supervisor claim-time gate

- **status**: modified
- **upstream**: —
- **why**: PRD #29 Track B (per-issue cap). #32 shipped the `count_blocked_since_guidance` counter; this slice wires it end-to-end so an issue that keeps coming back BLOCKED with no fresh human directive is flipped to `ready-for-human` and skipped instead of burning worker after worker on the same dead loop.
- **what changed**: `afk.sh` gains `per_issue_cap` (reads `RED_AFK_PER_ISSUE_CAP`, default 3, defensive — `0`/non-numeric/negative falls back to 3), `_thread_lacks_directive_marker` (true when the thread has no `<details data-kind="directive">` carrier, so the trip comment teaches the syntax), and `trip_per_issue_cap` (flips `ready-for-agent` → `ready-for-human`, posts a trip comment, appends a copy-pasteable directive-marker self-teaching block when no directive exists; gh failures warn but never crash). `process_issue` gains a claim-time gate: before claiming it fetches comments, counts the trailing BLOCKED run, and on `count ≥ cap` trips and skips the issue without recording a worker spawn. `README.md` operator-tunables table gains a `RED_AFK_PER_ISSUE_CAP` row. `per-issue-cap.test.sh` gains defensive-parsing, marker-detection, and 5 gh-stubbed integration fixtures. Refs #35.

---

## afk (engineering) — AGENT-PROMPT precedence ladder + thread-discussion tie-breaker

- **status**: modified
- **upstream**: —
- **why**: PRD #29 Track A (directive redesign). The handoff now carries a fifth top-level element, `<thread-discussion>` — human-authored comments that did not contain a `<details data-kind="directive">` marker — and the inner agent needs an explicit precedence ladder plus a tie-breaker rule so advisory chatter never gets misread as authority. Without the ladder, two failure modes were observed in PRD #29 dry-runs: agents quoting thread-discussion to override the brief, and agents emitting BLOCKED when an old brief disagreed with newer human guidance (which is exactly the resolution, not a contradiction).
- **what changed**: `AGENT-PROMPT.md` Handoff Anatomy grows from four to five top-level elements; `<thread-discussion>` is documented as advisory-only, lowest authority. New explicit four-rung precedence ladder (`<human-guidance>` > `<issue-body>` incl. HITL body edits > `<previous-attempts>` > `<thread-discussion>`). New tie-breaker rule for `<thread-discussion>` with the two-condition gate — agent may consult it only when (i) the brief is ambiguous AND (ii) no `<human-guidance>` resolves the ambiguity; never to override explicit brief; never to justify BLOCKED. New precedence example showing a `<human-guidance>` comment beating an older acceptance criterion. Existing "latest `<human-guidance>` overrides `<issue-body>`" bullet preserved verbatim. Refs #33.

---

## afk (engineering) — per-issue BLOCKED cap counter (`count_blocked_since_guidance`)

- **status**: modified
- **upstream**: —
- **why**: PRD #29 Track B needs a deterministic per-issue cap so a single stuck issue can't soak the `ready-for-agent` queue with repeated BLOCKED attempts. The cap state is implicit in the comments thread (envelopes + human directives) and must reset cleanly whenever a human hands down fresh guidance.
- **what changed**: new pure function `count_blocked_since_guidance(comments_json) → int` in `afk.sh`. Walks the comments array backwards, counts the trailing run of `data-attempt-status="blocked"` envelopes, and stops on either a `directive_carrier` comment (well-formed `<details data-kind="directive">…</details>` after the audit-noise filter) or a non-blocked envelope (DONE / no-sentinel / merge-conflict / discarded) breaking the trailing-BLOCKED run. `thread_discussion` (narrative) and `audit_noise` (boot stamp / promotion audit / heartbeat / blank) comments are skipped without resetting. Pure: jq only, no `gh`, no filesystem. Private helper `_comment_is_directive_carrier` ships alongside; full classifier consolidation lives in #30 (which downstream slices will use to replace these inline checks). New test suite `per-issue-cap.test.sh` (14 cases) covers all acceptance criteria in isolation. Refs #32.

---

## afk (engineering) — env var rename to `RED_AFK_*` (BREAKING)

- **status**: modified
- **upstream**: —
- **why**: Every env var the skill defined was using ad-hoc prefixes — `TARGET`, `SUPERVISOR_*`, `STALL_*`, `WATCHDOG_*`, `MONITOR_*`, `CARGO_TARGET_BASE`, `GRADLE_USER_HOME_BASE` (operator knobs) and `AFK_*` (hook/detector contract). Two problems: (1) generic names like `TARGET` and `MONITOR_COMPACT` collide with environment vars set by unrelated tools or the operator's shell config; (2) the mix of prefixes made it impossible to grep `env | grep RED_AFK_` to see "everything red-skills/afk is currently seeing." Project-wide convention: all RedSkills env vars start with `RED_*`.
- **what changed**: every env var the afk skill reads or exports is now prefixed `RED_AFK_*`. Hard break — no compat shim, no deprecation warning, no fallback to the old names. Rename map (old → new):
  - Operator tunables: `TARGET` → `RED_AFK_TARGET`, `SUPERVISOR_STAGGER_S` → `RED_AFK_STAGGER_S`, `SUPERVISOR_POLL_S` → `RED_AFK_POLL_S`, `SUPERVISOR_FAST_DEATH_S` → `RED_AFK_FAST_DEATH_S`, `SUPERVISOR_CIRCUIT_K` → `RED_AFK_CIRCUIT_K`, `SUPERVISOR_CIRCUIT_WINDOW_S` → `RED_AFK_CIRCUIT_WINDOW_S`, `STALL_THRESHOLD_SECONDS` → `RED_AFK_STALL_THRESHOLD_S`, `STALL_POLL_S` → `RED_AFK_STALL_POLL_S`, `WATCHDOG_GRACE_SECONDS` → `RED_AFK_WATCHDOG_GRACE_S`, `MONITOR_COMPACT` → `RED_AFK_MONITOR_COMPACT`, `CARGO_TARGET_BASE` → `RED_AFK_CARGO_TARGET_BASE`, `GRADLE_USER_HOME_BASE` → `RED_AFK_GRADLE_USER_HOME_BASE`.
  - Hook/detector contract (exported into each worker's subshell, read by `.red/hooks/*.sh` and shipped detectors): `AFK_SLOT` → `RED_AFK_SLOT`, `AFK_WORKER_ID` → `RED_AFK_WORKER_ID`, `AFK_RUNNER` → `RED_AFK_RUNNER`, `AFK_ISSUE` → `RED_AFK_ISSUE`, `AFK_BRANCH` → `RED_AFK_BRANCH`, `AFK_ITER_DIR` → `RED_AFK_ITER_DIR`, `AFK_ITER_STATUS` → `RED_AFK_ITER_STATUS`, `AFK_MERGE_SHA` → `RED_AFK_MERGE_SHA`, `AFK_MERGE_BASE` → `RED_AFK_MERGE_BASE`, `AFK_DURATION_S` → `RED_AFK_DURATION_S`, `AFK_EXIT_CODE` → `RED_AFK_EXIT_CODE`, `AFK_STATE_FILE` → `RED_AFK_STATE_FILE`, `AFK_PLUGIN_DIR` → `RED_AFK_PLUGIN_DIR`, `AFK_HOOK_ENV_FILE` → `RED_AFK_HOOK_ENV_FILE`.
  - Internal-only shell vars (`PROJECT_ROOT`, `ITER_DIR`, `ITER_LOG`, `STATE_FILE`, `RUNNER`, `WORKER_ID`, `CURRENT_ISSUE`, `CURRENT_BRANCH`, `SKILL_DIR`, `SCRIPT_DIR`) are untouched — they never cross the process boundary so they don't need the prefix.
  - On-disk filenames (`afk-supervisor.log`, `afk-supervisor-defaults.txt`, `afk.pid`, `afk.log`, `afk.state.json`, `afk-attempts/…` branch namespace) are untouched — they are paths, not env vars.
  - Applied across all in-scope files via word-boundary `sed -E "s/\bOLD\b/NEW/g"` (so `TARGET` inside `CARGO_TARGET_BASE` is naturally safe — `_` is a word char, `\b` doesn't fire between letters and `_`): 8 production scripts (`afk.sh`, `supervisor.sh`, `monitor.sh`, `hooks.sh`, `once.sh`, `statusline.sh`, `config.sh`, `lib/state.sh`), 2 shipped detectors (`cargo.sh`, `gradle.sh`), 6 skill-level docs (`SKILL.md`, `SAFETY.md`, `AGENT-PROMPT.md`, `runner-claude.md`, `runner-codex.md`, `detectors/README.md`), root `README.md`, and 13 test suites under `scripts/tests/`. Historical entries in `CHANGES.md` are left alone — they describe past state at the time of the change and should not be revisionist.
- **Migration**: anyone who exported the old names in their shell rc, CI pipeline, project `.env`, or wrapper scripts must rename them. `env | grep -E '\b(TARGET|SUPERVISOR_|STALL_|WATCHDOG_|MONITOR_COMPACT|CARGO_TARGET_BASE|GRADLE_USER_HOME_BASE|AFK_)' | grep -v RED_AFK_` to find leftover settings on the host.
- **Tests**: all 13 afk suites green post-rename — config-loader 33/33, detectors 26/26, envelope-shape 37/37, handoff-builder 53/53, hooks-orchestrator 27/27, lifecycle-hooks 16/16, runner-detection 14/14, sentinel-detection 5/5, stall-detector 16/16, state-accessor 57/57, supervisor-hooks 27/27, trip-sweep 39/39. Pre-existing `statusline.test.sh` case1 failure on `main` unrelated and unchanged.

---

## afk (engineering) — handoff as top-level XML elements (`<issue-body>` / `<previous-attempts>` / `<human-guidance-thread>` / `<agent-notes>`)

- **status**: modified
- **upstream**: —
- **why**: Field reports of inner-agent confusion on multi-attempt issues: the agent couldn't distinguish the issue *body* from issue *comments*, and couldn't distinguish *human* comments from *orchestrator* comments. Root cause was twofold. (1) The handoff used markdown headers (`## Brief`, `## Previous attempts`, `## Human guidance`, `## Notes`) for top-level sections — but the issue body itself is markdown and routinely contains its own `## Notes`, `## Acceptance`, `## HITL decision`, etc. headers, so the section boundaries blurred and the agent had no syntactic guarantee that "this `## Notes`" was the handoff's scratchpad vs. a section the human pasted into the body. `AGENT-PROMPT.md` only documented `## Brief`, leaving the other three sections and the rebuild-per-attempt semantics implicit, so agents fell back to guessing and emitted spurious `BLOCKED` when a HITL decision in a comment "contradicted" an older acceptance criterion in the brief. (2) `build_human_guidance` rendered each block with a bare `_@login · timestamp_` header, but every comment posted from the orchestrator host through `gh issue comment` shows up under the operator's GitHub login — so the displayed author was indistinguishable between orchestrator audits and real human direction.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: `build_retry_handoff_body` now wraps each of the four top-level sections in an XML element instead of a markdown `##` header. Layout: top-of-file frontmatter (`source:` / `prd:` / `runner:` / `started:` / `attempt:`) stays as bare key:value lines, then `<issue-body>…issue body verbatim…</issue-body>`, then optional `<previous-attempts>` containing one or more `<previous-attempt n="N" status="…" worker="…" duration="…" branch="…">` children with `<notes>` / `<drop>` / `<log>` sub-elements, then optional `<human-guidance-thread>` containing one or more `<human-guidance author="@user" at="iso8601">…verbatim comment body…</human-guidance>` children, then `<agent-notes>…</agent-notes>` (with the existing HTML-comment placeholder for an empty scratchpad). `build_previous_attempts` and `build_human_guidance` rewritten to emit the new tag shapes; chronological ordering preserved; the `comment_is_human_guidance` predicate is unchanged (still strips orchestrator audits — boot stamps, promotion lines, heartbeats, envelopes — by body shape, *before* the builder runs, so anything reaching `<human-guidance>` is by construction a human directive). `extract_handoff_notes` rewritten to parse content between `<agent-notes>` and `</agent-notes>` instead of awk-ing past `## Notes`; the placeholder-comment + leading/trailing-blank stripping behaviour is preserved so the `<details data-section="notes">` block on `blocked` / `no-sentinel` envelopes is byte-for-byte identical when no notes were appended.
  - `plugins/dev/skills/engineering/afk/AGENT-PROMPT.md`: rewrote the `## Handoff Anatomy` section to describe the four XML elements (with attribute schemas), state explicitly that the handoff is rebuilt fresh per attempt (so body edits and new comments land automatically), instruct the agent to trust the `<human-guidance>` *tag* over the `author` attribute (gh author-login is indistinguishable between human and orchestrator-posted comments), and codify the precedence rule: most-recent `<human-guidance>` (or HITL edits pasted into `<issue-body>`) overrides older acceptance criteria — disagreement on its own is *not* grounds for `BLOCKED`. Updated the existing references to `## Acceptance` / `## Refs` / `## Suggested Skills` / `## Notes` throughout the file: those markdown sections still exist but they now live *inside* `<issue-body>`, except `## Notes` which became `<agent-notes>` (workflow step 2 and "If You Get Stuck" instruct the agent to append "inside `<agent-notes>`" instead of "a `## Notes` entry").
  - `plugins/dev/skills/engineering/afk/SKILL.md`: rewrote the *Handoff File Template* block to show the new XML structure with annotated children; updated the file-table description of `handoff.md` to enumerate the four wrappers; updated step 3 of the orchestrator loop to describe the XML wrappers; updated the two `## Notes` references in the envelope schema section to `<agent-notes>` (the envelope's `data-section="notes"` block still carries the inner-agent's appended scratchpad — the source is what changed, not the envelope shape).
  - `plugins/dev/skills/engineering/afk/scripts/tests/handoff-builder.test.sh`: case 1's markdown-header assertions (`## Brief`, `## Previous attempts`, `### Attempt 1`, `## Human guidance`, `## Notes`) replaced with XML-tag assertions (`<issue-body>` open/close, `<previous-attempts>`, `<previous-attempt n="1"`, `status="blocked"`, `<human-guidance-thread>`, `<human-guidance author="@alice"`, `<agent-notes>` open/close) and explicit negative assertions that the legacy `## Brief` / `## Notes` headers no longer appear. Case 2's `human_count_2` grep and `attempts_count_2` grep both updated to the new XML anchors. Case 4 (zero-comments) assertions inverted from "no `## Previous attempts` / `## Human guidance` headers, has `## Notes`" to "no `<previous-attempts>` / `<human-guidance-thread>` wrappers, has `<agent-notes>`". Case 5 (malformed envelope) updated to the new XML anchors. New case 6 round-trips the new XML format end-to-end: invokes `build_retry_handoff_body` to write a real handoff to disk, simulates the inner agent appending notes inside `<agent-notes>`, then asserts `extract_handoff_notes` returns the appended text without the placeholder comment, the opening tag, or the closing tag — locks the contract `extract_handoff_notes` has with the new format and proves the `data-section="notes"` envelope block stays byte-clean. 53/53 green (was 45/45 + 8 new).
- **Tests**: handoff-builder 53/53 green. All other afk suites untouched and green (config-loader 33/33, detectors 26/26, envelope-shape 37/37, hooks-orchestrator 27/27, lifecycle-hooks 16/16, runner-detection 14/14, sentinel-detection 5/5, stall-detector 16/16, state-accessor 57/57, supervisor-hooks 27/27, trip-sweep 39/39). The pre-existing `statusline.test.sh` case1 failure on `main` (unrelated — `.red/tmp`-missing branch) is unchanged.

---

## afk (engineering) — supervisor `pre-spawn` + `post-exit` hook integration, monitor `defaults:` header

- **status**: modified
- **upstream**: —
- **why**: Issue #18 landed the generic hook orchestrator and #19 shipped the `cargo` / `gradle` detectors plus a one-shot boot-log line. Issue #21 closes the framework loop on the supervisor side: every worker spawn now drives the orchestrator's `pre-spawn` chain (with `AFK_SLOT` / `AFK_WORKER_ID` / `AFK_RUNNER` / `AFK_PLUGIN_DIR` / `AFK_HOOK_ENV_FILE` populated), every worker termination drives `post-exit` (adding `AFK_EXIT_CODE` and `AFK_DURATION_S`), and the monitor's fleet header surfaces the applied detectors in a new `defaults:` field so the human sees what fired without grepping `.red/tmp/afk-supervisor.log`. End-to-end: a Rust project gets per-slot `CARGO_TARGET_DIR=/opt/cargo-target/slot-N` with zero per-project configuration, and the operator can see that happen at a glance.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/supervisor.sh`:
    - New `PLUGIN_DIR` (parent of `SCRIPT_DIR`) and `DEFAULTS_FILE` (`$TMP_DIR/afk-supervisor-defaults.txt`) constants; new per-slot arrays `SLOT_WORKER_IDS` and `SLOT_APPLIED_DETECTORS`.
    - New `gen_supervisor_wid` returning a `wXXXX` ID for the AFK_WORKER_ID contract — distinct from the runtime ID that `afk.sh` picks for itself.
    - New `write_defaults_file` atomically writes the most-recent applied detector list (newline-terminated, space-separated names) via tmp+`mv -f`. Read by `monitor.sh`.
    - New `run_pre_spawn_hooks SLOT WORKER_ID` fires the `pre-spawn` chain inside a subshell. The subshell snapshots `env` before sourcing `hooks.sh`, runs `hooks_run pre-spawn`, then `comm -13`'s a sorted env diff to isolate exactly the env vars the detectors exported. Caller reads `applied` (basenames) and `env` (`KEY=value` lines) from a freshly-`mktemp -d`'d directory. Detector exports never leak into the supervisor's own environment.
    - New `run_post_exit_hooks SLOT WORKER_ID EXIT_CODE DURATION_S` fires the `post-exit` chain best-effort — stdout/stderr suppressed, non-zero rc logged but never propagated (matches the `post-*` continue-on-error semantics in `hooks.sh`).
    - `spawn_slot` rewritten to (1) generate a worker ID, (2) call `run_pre_spawn_hooks` and abort the spawn (returning the hook rc) on non-zero, (3) build `env_args` from the detector-exported env, (4) append legacy `BUILD_ISOLATION_VARS` overrides so operator-set `CARGO_TARGET_BASE` / `GRADLE_USER_HOME_BASE` still win, (5) `nohup env "${env_args[@]}" "$AFK_SH" "$PROJECT_ROOT" &` as before, and (6) log a canonical `pre-spawn: applied detectors [<names>]` line per spawn (renders `[]` when nothing applied — required for the non-build acceptance criterion). The applied list is persisted to `DEFAULTS_FILE` on every successful spawn.
    - `handle_dead_slot` now reaps the worker zombie with `wait $pid` (`$?` becomes `AFK_EXIT_CODE`; default 0 when `wait` fails — e.g. the pid was already reaped), computes duration as `now - SLOT_SPAWN_EPOCH`, and invokes `run_post_exit_hooks` before the existing fast-death / circuit-trip logic.
    - `log_applied_detectors_boot_line` moved above the source-guard so the function is reachable from unit tests; the body now also calls `write_defaults_file "$applied"` so the monitor's `defaults:` field is correct from the first refresh, even before any slot has spawned.
    - `cleanup` now removes `DEFAULTS_FILE` alongside `PID_FILE` / `CIRCUIT_FILE` so a clean shutdown leaves no stale defaults state behind.
  - `plugins/dev/skills/engineering/afk/scripts/monitor.sh`: `render_fleet_header` reads `DEFAULTS_FILE` and appends a `defaults: <names>` (comma-separated, e.g. `defaults: cargo, gradle`) or `defaults: -` (missing file, empty file, or only-newline content) field to the live `🛡️ supervisor pid=…` line. STALE supervisor + no-supervisor cases are unchanged — the header is still gated on a live pid file.
  - `plugins/dev/skills/engineering/afk/scripts/tests/supervisor-hooks.test.sh`: new — 27 assertions. Exercises `gen_supervisor_wid` format, `write_defaults_file` round-trip, `run_pre_spawn_hooks` against the real shipped detector directory (bare project → empty applied + empty env; Rust project → `cargo` applied + `CARGO_TARGET_DIR=${CARGO_TARGET_BASE}/slot-N` env content + slot dir created; env diff excludes our own `AFK_*` exports; project-local detector returning rc=99 propagates), `run_post_exit_hooks` env contract (`AFK_SLOT` / `AFK_WORKER_ID` / `AFK_EXIT_CODE` / `AFK_DURATION_S` reach the project `post-exit.sh` main hook and the wrapper swallows non-zero rc), `log_applied_detectors_boot_line` seeds `DEFAULTS_FILE` with the applied list (Rust) or empty (bare project), and a tmp-project fixture drives `monitor.sh --once` to confirm the `defaults: cargo, gradle` rendering, the `defaults: -` fallback on empty / missing files, and the header's absence when there's no supervisor pid. Structural greps lock the `spawn_slot` / `handle_dead_slot` wiring (`run_pre_spawn_hooks "$slot" "$worker_id"`, `pre-spawn hook failed` log, `run_post_exit_hooks "$slot" …`, `wait "$pid"`, `AFK_PLUGIN_DIR="$PLUGIN_DIR"`).
  - Tests: new `supervisor-hooks` suite (27/27) + all existing afk suites green — config-loader 33/33, detectors 26/26, envelope-shape 37/37, handoff-builder 44/44, hooks-orchestrator 27/27, lifecycle-hooks 16/16, runner-detection 14/14, sentinel-detection 5/5, stall-detector 16/16, state-accessor 57/57, trip-sweep 39/39. The pre-existing `statusline.test.sh` case1 failure on `main` (script emits a project-basename block when `.red/tmp` is missing; test expects empty) is unrelated and untouched.

---

## afk (engineering) — detector framework, shipped `cargo` + `gradle` detectors, pre-spawn boot-log

- **status**: modified
- **upstream**: —
- **why**: Issue #18 landed the generic three-layer hook orchestrator, and #20 wired the per-iteration lifecycle hooks into `afk.sh`. Issue #19 closes the framework loop on the `pre-spawn` hook point by (a) defining the detector convention as a single short README under a new `detectors/` directory in the skill, (b) shipping two real detectors (`cargo.sh`, `gradle.sh`) that per-worker isolate Rust and Gradle build caches so the fleet never serializes on `.cargo-lock` / Gradle daemon lockfiles, and (c) adding a single boot-log line (`pre-spawn: applied detectors […]`) that surfaces the otherwise-invisible "magic" the first time `/afk` runs on a project. The orchestrator's existing applied-list and config-gating behaviour already supported the convention — this slice ships real detectors that exercise it and wires the announcement into both entry points.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/detectors/README.md`: new — documents the convention. A detector is a single `*.sh` file; first step is an applicability check that `exit 1`s if not applicable (treated by the orchestrator as "skip silently"); if applicable, it writes `KEY=value` lines to `$AFK_HOOK_ENV_FILE` and `exit 0`. Any other exit code is an error (orchestrator aborts on `pre-*` points, logs and continues on `post-*`). Project-local detectors at `<project>/.red/hooks/detectors/*.sh` follow the same convention. Disabling a shipped detector is a single key under `afk.hooks.defaults` in `.red/config.yaml`.
  - `plugins/dev/skills/engineering/afk/detectors/cargo.sh`: new — applies on Rust projects (`Cargo.toml` at `PROJECT_ROOT`). Exports `CARGO_TARGET_DIR=${CARGO_TARGET_BASE:-/opt/cargo-target}/slot-${AFK_SLOT}` so each worker slot compiles into its own target directory. The `mkdir -p` runs before the export so the first run on a fresh host succeeds. `CARGO_TARGET_BASE` overrides the default base path.
  - `plugins/dev/skills/engineering/afk/detectors/gradle.sh`: new — applies on Gradle projects (any `build.gradle*` at `PROJECT_ROOT`) **and** only when the operator has opted in by setting `GRADLE_USER_HOME_BASE` in the supervisor's environment. Without the base var the detector is a no-op (`exit 1`) — deliberate opt-in so the framework never claims a path on the user's filesystem without consent. When both conditions hold, exports `GRADLE_USER_HOME=${GRADLE_USER_HOME_BASE}/slot-${AFK_SLOT}` and pre-creates the directory.
  - `plugins/dev/skills/engineering/afk/scripts/supervisor.sh`: new `log_applied_detectors_boot_line` helper runs the orchestrator's `pre-spawn` chain once at supervisor boot (just before the slot-spawn loop) in a subshell — that way detector exports stay scoped to the announcement and never leak into the supervisor's own env (per-slot env propagation remains owned by `BUILD_ISOLATION_VARS`). When `HOOKS_APPLIED_DETECTORS` is non-empty, the helper writes `pre-spawn: applied detectors [<names>]` via the existing `log` function to `.red/tmp/afk-supervisor.log`. Detectors that exited 1 or were disabled via `.red/config.yaml` are omitted from the line.
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: new `log_applied_detectors_boot_line` helper runs `hooks_run pre-spawn` directly in the worker shell after `bootstrap`, so detector exports propagate to every issue the worker processes. The same boot-line is emitted via the worker's `log` function — captured into `.red/tmp/afk-supervisor-slot-N.log` when the worker was spawned by the supervisor.
  - `plugins/dev/skills/engineering/afk/scripts/tests/detectors.test.sh`: new — 26 assertions. Exercises `cargo.sh` directly (no `Cargo.toml` → exit 1 with untouched env-file; with `Cargo.toml` → exit 0 and writes the correct `CARGO_TARGET_DIR=…/slot-N` line; `CARGO_TARGET_BASE` overrides the default; the target directory is `mkdir -p`'d before writing). Exercises `gradle.sh` directly (no `build.gradle*` → exit 1; present but `GRADLE_USER_HOME_BASE` unset → exit 1; both → exit 0 with the matching `GRADLE_USER_HOME=…/slot-N` line and `mkdir -p` of the home dir). Drives the orchestrator's real shipped detector directory through `hooks_run pre-spawn` to verify `HOOKS_APPLIED_DETECTORS` reports `cargo` on a cargo-only project, drops `cargo` when `afk.hooks.defaults.cargo: false` is set in `.red/config.yaml`, and stays empty on a project with neither marker. Structural greps assert both `supervisor.sh` and `afk.sh` define and call `log_applied_detectors_boot_line` and emit the canonical phrase `pre-spawn: applied detectors`.
  - Tests: new `detectors` suite (26/26) + existing afk suites still green — config-loader 33/33, envelope-shape 37/37, handoff-builder 44/44, hooks-orchestrator 27/27, lifecycle-hooks 16/16, runner-detection 14/14, sentinel-detection 5/5, stall-detector 16/16, state-accessor 57/57, trip-sweep 39/39. The pre-existing `statusline.test.sh` case1 failure on `main` (project-basename block emitted when `.red/tmp` is missing) is unrelated to this slice and untouched.

---

## afk (engineering) — migrate `monitor.sh` and `statusline.sh` to `lib/state.sh` accessor

- **status**: modified
- **upstream**: —
- **why**: Issue #26 landed `lib/state.sh` as the schema-owning accessor for `.red/tmp/work-*/afk.state.json` and migrated `afk.sh` onto it. Issue #27 finishes the migration for the two remaining state-file consumers — `monitor.sh` and `statusline.sh` — so the v1 schema lives in exactly one place. Adding a state field is now a one-line change to `_STATE_JQ_FILTER` in `lib/state.sh`; no consumer needs to learn the JSON shape.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/monitor.sh`: sources `lib/state.sh`. Both `render_worker_compact` and `render_worker` now call `state_read_into st "$state_file"` once per state file (replacing six-to-eight `jq -r` invocations per worker) and read the documented `$st_*` variables. The liveness check (previously `cat .../afk.pid` then `kill -0`) becomes `state_is_live "$state_file"` — afk.sh keeps the state-file `.pid` in sync with the pid file, so both checks resolve identically. The default-value contract is preserved verbatim by mapping the accessor's empty-string defaults back to the original `"-"` sentinels via `${st_field:--}` parameter expansion (compact: `current_n` / `current_title` / `current_stage`; full: same plus `current_worktree`). Per-iteration `elapsed` still prefers `.current.started_at` over `.started_at` via `${st_current_started_at:-${st_started_at}}`. The `avg_s` ETA computation no longer reads the state file directly: `jq -rn --argjson d "${st_durations_seconds:-[]}" '…'` consumes the JSON-encoded array the accessor exposes. No direct `jq` against `afk.state.json` remains. Out-of-scope `jq` calls against `afk-supervisor-circuit.json` (parked/stalled slot rendering) and `afk-history.jsonl` (sparkline) are untouched — those files belong to other modules.
  - `plugins/dev/skills/engineering/afk/scripts/statusline.sh`: sources `lib/state.sh`. The per-worker loop replaces six `jq -r` reads (`pid`, `blocked`, `current.diff_added`, `current.diff_removed`, `current.worktree`, `current.number`) with one `state_read_into st "$state"` plus `state_is_live "$state"` for liveness. The worktree-diff fallback (when `diff_added` / `diff_removed` are both zero) is preserved, including the `git -C "$worktree" diff --shortstat origin/main` shell-out. Issue numbers continue to be filtered via `[[ -n "$st_current_number" ]]` — empty defaults from `state_read_into` are semantically equivalent to the original `// empty` filter. Warm-cache statusline timing on a 2-worker checkout measured 47 ms (was 55 ms before), so the accessor's single-parse-per-file approach is a slight win and well under the 100 ms SLO.
  - Byte-identity verified with hand-rolled fixtures covering live + dead + missing-pid workers and full + partial + empty state files. `diff` of pre- and post-migration `monitor.sh --once` output and `statusline.sh` output is empty for every fixture exercised.
  - Tests: no test files modified. All existing afk suites green — config-loader 33/33, envelope-shape 37/37, handoff-builder 44/44, hooks-orchestrator 27/27, lifecycle-hooks 16/16, runner-detection 14/14, sentinel-detection 5/5, stall-detector 16/16, state-accessor 57/57, trip-sweep 39/39. The pre-existing `statusline.test.sh` failure on `main` (case1 — script emits the project-basename block when `.red/tmp` is missing, test expects empty) is unrelated to this migration and untouched.

---

## afk (engineering) — `afk.sh` per-iteration lifecycle hook integration

- **status**: modified
- **upstream**: —
- **why**: Issue #18 landed the generic orchestrator (`hooks.sh::hooks_run`), but `afk.sh` was still sourcing it without calling it. Issue #20 wires the four per-iteration call sites the orchestrator was built for — pre-iteration, pre-merge, post-merge, post-iteration — into the per-issue loop with the documented env contract. After this slice, projects can drop `.red/hooks/<point>.sh` (or per-layer detectors) and have them run at the right moment without touching `afk.sh`. Claim semantics, worktree layout, and state-file shape are unchanged; the integration is purely additive.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: new `run_lifecycle_hook` helper exports the shared env contract (`AFK_SLOT`, `AFK_WORKER_ID`, `AFK_RUNNER`, `AFK_ISSUE`, `AFK_ITER_DIR`, `AFK_BRANCH`, `AFK_STATE_FILE`, `AFK_PLUGIN_DIR`) then calls `hooks_run`; trailing `KEY=VAL` args become per-call overrides/extras (used by pre-merge to add `AFK_MERGE_BASE`, post-merge to add `AFK_MERGE_SHA`, post-iteration to add `AFK_ITER_STATUS` and `AFK_DURATION_S`). `snapshot_iter_for_hook` + `fire_post_iteration` capture `ITER_DIR` / `STATE_FILE` just before `iter_close_*` zeroes the live cursors, so post-iteration hooks still see the brief-promised paths after cleanup. `process_issue` fires `pre-iteration` immediately after the `running` label edit succeeds and before `git worktree add`; a non-zero hook restores `ready-for-agent`, removes `ITER_DIR`, releases the claim lock, and returns. `do_merge` fires `pre-merge` (with `AFK_MERGE_BASE` from `git merge-base HEAD <branch>`) before `git merge --no-ff` — a non-zero exit funnels through the existing merge-conflict path — and fires `post-merge` (with `AFK_MERGE_SHA`) after `git push origin main`. Every terminal path in `process_issue` (BLOCKED sentinel, no-sentinel, merge-conflict, done, both exhausted-runner exits) now calls `fire_post_iteration` with the matching `AFK_ITER_STATUS` (`blocked` / `no-sentinel` / `merge-conflict` / `done` / `discarded`) and the iteration's wall-clock `AFK_DURATION_S`. Post-iteration hook failures are logged via the orchestrator and do not change the iteration's outcome.
  - `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-hooks.test.sh`: new — 16 assertions. Sources `afk.sh` (with `set +e` to undo `afk.sh`'s inherited `set -e`) and stubs `hooks_run` to record every invocation's exported env vars. Covers: full env contract is exported for pre-iteration; pre-merge carries `AFK_MERGE_BASE`; post-merge carries `AFK_MERGE_SHA`; non-zero rc from the orchestrator propagates back to the caller (so pre-iteration / pre-merge can abort); `fire_post_iteration` replays the snapshotted `ITER_DIR` / `STATE_FILE` after cleanup, sets `AFK_ITER_STATUS` + `AFK_DURATION_S`, clears the per-iteration cursors, and swallows + logs hook failures instead of propagating them. Two structural greps assert `process_issue` covers all five documented terminal statuses and `do_merge` wires both merge hooks; one grep asserts the pre-iteration abort restores `ready-for-agent`.
  - Tests: new lifecycle-hooks suite (16/16) + existing afk suites still green — config-loader 33/33, envelope-shape 37/37, handoff-builder 44/44, hooks-orchestrator 27/27, runner-detection 14/14, sentinel-detection 5/5, stall-detector 16/16, state-accessor 57/57, trip-sweep 39/39. The pre-existing `statusline.test.sh` failure on `main` is unrelated and untouched.

---

## afk (engineering) — extract `lib/state.sh` accessor module + migrate `afk.sh`

- **status**: modified
- **upstream**: —
- **why**: `afk.sh` was the most demanding consumer of `.red/tmp/work-*/afk.state.json` — both reader and writer — and inlined `jq` filters at every callsite. Adding a field (e.g. `current.diff_added`) meant grepping for every reader and writer and patching defaults on each. Issue #26 closes that gap by extracting a schema-owning accessor module that the rest of the AFK toolchain (`monitor.sh`, `supervisor.sh`, `statusline.sh`) can migrate onto in later slices.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/lib/state.sh`: new — exposes `state_read_into`, `state_write`, `state_init`, `state_is_live`. `state_read_into PREFIX path` does a single `jq` invocation, emits `<flat_key>=<@sh-quoted-value>` lines, and sets `${PREFIX}_<key>` shell vars (nested fields like `.current.number` flatten to `current_number`). Defaults are encoded inside the read filter — adding a v1 field is a one-line change. Missing files yield defaults silently; malformed JSON logs a warning to stderr and yields defaults (never aborts the caller). `state_write path key=value key2:=jsonliteral …` composes a single jq filter, writes via `mktemp -p <dir> path.tmp.XXXXXX`, then `mv`s atomically — `:=` flags raw JSON, `=` treats the value as string. `state_init path …` resets to a fresh v1 doc (`version:=1`, `envelope:={posted:false}`). `state_is_live path` returns 0 iff `.pid` is alive via `kill -0` (treats `0` / missing / null as dead).
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: migrated. The local `state_write` / `state_read` / `state_init` / `state_set` functions are gone (~45 LOC removed); `afk.sh` now sources `lib/state.sh` and routes every state-file access through it. Every `state_set "<jq filter>"` callsite became `state_write "$STATE_FILE" field=value …`. The direct `jq -r '.current.number // empty' "$state_file"` and `jq -r '.envelope.posted // false' "$state_file"` lookups in `prune_orphans` and `cleanup` became `state_read_into _orphan "$state_file"` / `_cleanup_current_number` reads. No `jq` invocation that touches a state file remains in `afk.sh`.
  - `plugins/dev/skills/engineering/afk/scripts/tests/state-accessor.test.sh`: new — 57 assertions across two families. Family 1 (fixture reads) covers `v1-full`, `v1-missing-current`, `v1-legacy-no-diff-fields`, and `v1-malformed` (asserts the stderr warning and default-fallback). Family 2 (round-trip writes) covers `state_init` defaults, nested dotted writes (`current.stage=impl`, `envelope.posted:=true`), JSON-literal writes (arrays / `current:=null`), `state_is_live` against live/dead/zero pids, and an atomic-write probe that runs two concurrent writers against one file and asserts the final document parses as JSON with no `.tmp.*` shrapnel left on disk.
  - `plugins/dev/skills/engineering/afk/scripts/tests/fixtures/state/{v1-full,v1-missing-current,v1-legacy-no-diff-fields,v1-malformed}.json`: new fixtures consumed by the test above.

---

## setup-red-skills (engineering) — scaffold `.red/config.yaml` commented template

- **status**: modified
- **upstream**: —
- **why**: PRD #16's hook system and the config loader landed in #17 give consumers a real `.red/config.yaml` schema, but a fresh repo still arrives with no file at all — meaning the user has to read the loader source (or a CHANGES entry) to discover that `afk.default_runner`, `afk.fleet.target`, and `afk.hooks.defaults.{cargo,gradle}` exist. Issue #22 closes that gap: when `/dev:setup-red-skills` runs on a repo missing the file, it drops a fully-commented snapshot of every v1 knob into `.red/config.yaml`. The file is a no-op until the user uncomments a line, but every available override is one ctrl-F away.
- **what changed**:
  - `plugins/dev/skills/engineering/setup-red-skills/config-template.yaml`: new — verbatim seed file the skill copies into the consumer repo. Header comment explains the file's purpose ("per-project plugin settings consumed by `/afk` and friends") and the override rule ("Uncomment any line to override the default"). Body lists every key the loader documents at v1 — `afk.default_runner=claude`, `afk.fleet.target=2`, `afk.hooks.defaults.cargo=true`, `afk.hooks.defaults.gradle=true` — each on its own commented line with the default value and an inline comment explaining the knob. When fully uncommented the YAML is syntactically valid and consumed verbatim by `config.sh`.
  - `plugins/dev/skills/engineering/setup-red-skills/SKILL.md`: new **Section G — `.red/config.yaml` template (automatic)** explainer in step 2, no user decision (auto-scaffold). New write step in step 4 paired with Section G: log `.red/config.yaml already present — leaving as-is` and skip when the file exists; otherwise ensure `.red/` exists and copy `config-template.yaml` verbatim. The skill explicitly does **not** `git add` or commit the file — the user controls when it lands in git, matching the same idempotency / non-clobber rule already in place for `statusLine` (Section F).
  - No script change required — the loader in `plugins/dev/skills/engineering/afk/scripts/config.sh` already handles "file present" vs "file missing" (missing = all defaults), so the scaffolded all-commented file behaves identically to no file at all until the user uncomments something. Existing afk test suites are unaffected (config-loader 33/33 still green); this slice is documentation + a seed file with no runtime code path.

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
