# Memory plugin operates as a closed loop via Claude Code hooks, PR-merge automation, and CI drift guards

The Memory plugin ships with rich surfaces — the RedDB graph
(`.red/memory/graph.rdb`), the LLM Wiki (`.red/wiki/`), the domain glossary
(`.red/CONTEXT.md`), the context map (`.red/CONTEXT-MAP.md`), the ADR set
(`.red/adr/`), and the harness-level auto-memory at
`~/.claude/projects/<project>/memory/MEMORY.md`. Today the population of
those surfaces is **passive in two directions**:

- The plugin **ships its hooks wired** at the plugin-distribution layer:
  `plugins/memory/hooks/{claude,codex}.hooks.json` declare `SessionStart`,
  `PostToolUse` (matcher `Edit|Write` for Claude, `apply_patch` for Codex),
  `Stop`, and `PreCompact` entries that each invoke
  `dist/cli.js hook <event> --runner <r>` with best-effort failure handling
  (`|| printf "{}"`). The dispatcher in `plugins/memory/src/hook-runtime.ts`
  routes them to `handleSessionStart` (engine `recall`), `handlePostToolUse`
  (`reindexFiles`), and `handleFlush` (`extractStructuredTranscript` +
  `factsToGraph`, then `PromotionEngine`). `recordLifecycle` writes each
  invocation into the Memory event log (ADR 0025). The plumbing is real;
  what is missing is policy on top of it (see Amendment below).
- `/memory:extract`, `/memory:ingest`, `/memory:recall`, `/wiki ingest`,
  `/context refresh` all require explicit invocation. Decisions made in a
  session (the interceptor pattern in ADR 0026, the mechanism-vs-hook
  separation rule, the `on_idle` distinction) land in markdown ADRs but
  do not become nodes in the graph unless the operator remembers to run
  `/memory:extract`.

The result is uneven: ADRs are well-maintained (27 files), the graph holds
35 MB of older state, the wiki index is 60 bytes, and
`MEMORY.md` lives outside the repo so it is per-machine rather than
per-project. The plumbing exists, the loop is open.

## Amendment — the three real gaps (2026-05-28)

The original "Decision" below conflated *the plugin distribution layer*
(where the hooks are already wired in `plugins/memory/hooks/*.hooks.json`)
with *the operator config layer* (`.claude/settings.json`, only the
branch-lock entry). Re-decided scope: do **not** wire any hook in
`.claude/settings.json`, do **not** ship a `.claude/hooks/memory/`
wrapper. The hooks already fire. What remains is **policy on top of the
existing wiring**, in three slices:

### Gap 1 — Audit marker contract (issue #218)

A formal way for any actor (Memory plugin, `/memory:ingest`, CI) to prove
an ingest happened on a specific commit SHA. Two equivalent forms:

- Commit trailer `Memory-Ingested: <sha>` (or `Memory-NoIngest: <reason>`
  as an explicit bypass for typos / formatting).
- Audit-log entry `<iso8601> ingest <path> <sha>` in
  `.red/memory/.audit.log`, written by `memory ingest`.

Both surfaces are visible across PRs (audit log tracked in the repo, or
the contract is restricted to the trailer form). Documented in
`.red/agents/memory.md`. Prerequisite for Gap 3.

### Gap 2 — PostToolUse path-scoping (issue #222)

`handlePostToolUse` runs end-to-end on every `Edit`/`Write` today and
delegates indexability to `reindexFiles`. The closed loop has a narrower
**declared interest**: `.red/adr/**`, `.red/wiki/pages/**`,
`.red/CONTEXT.md`, `.red/CONTEXT-MAP.md`, `.red/contexts/**`. Add a
declarative watched-globs list, consumed by the handler, that
short-circuits to noop before opening the store when no watched path is
in the changed-files payload. The `.hooks.json` matcher stays `Edit|Write`
(path matching is on the payload).

### Gap 3 — CI drift guard (issue #224)

`.github/workflows/red-memory-drift-guard.yml` fires on every PR. If
watched paths changed without an audit marker (Gap 1) on the head SHA,
fail with one actionable line pointing at `/memory:ingest <path>` or the
`Memory-NoIngest: <reason>` bypass. Emit `memory.drift.caught` into the
Memory event log on failure. The guard is the only loop closure CI can
enforce — local hooks already cover the Claude path; the guard
symmetrically catches Codex contributors and the human-only
"vim the ADR" case.

### Already implemented or merged

- SessionStart recall, PostToolUse reindex, Stop / PreCompact flush, and
  lifecycle logging: shipped in `plugins/memory/src/hook-runtime.ts`
  (issues #221 and #223 closed as already done).
- PR-merge → wiki extract Action (#219 — merged).
- Repo-versioned `MEMORY.md` migration (#220 — merged).

The original Decision section below is retained for history; refer to
this Amendment for the active scope.

## Decision

The Memory plugin becomes a **closed loop** by wiring three independent
automation layers, each handling a different temporal scope:

### 1. In-session: Claude Code hooks in `.claude/settings.json`

`config.json`'s flags get **actually wired** as hook entries in
`.claude/settings.json`, alongside the existing branch-lock hook:

| Hook event             | Action                                                              | Failure policy |
|------------------------|---------------------------------------------------------------------|----------------|
| `SessionStart`         | `memory recall --auto` — load context for the current branch / repo subtree into the session | log + continue |
| `Stop`                 | `memory extract` — extract decisions, why-notes, gotchas, root causes from the just-finished transcript into the graph | log + continue |
| `PreCompact`           | same as `Stop` — last chance before context compression deletes the transcript | log + continue |
| `PostToolUse` (Edit/Write on `.red/adr/*.md`, `.red/wiki/pages/*.md`, `.red/CONTEXT.md`, `.red/CONTEXT-MAP.md`) | `memory ingest <path>` — sync the just-edited markdown into the graph | log + continue |

Every hook is **best-effort**: a Memory plugin failure (provider down,
graph store locked) must never block a tool call or session boot. The
existing `dev` soft-uses-`memory` boundary (ADR 0009) is preserved.

### 2. On PR merge: GitHub Action populates the LLM Wiki

A `red-memory-wiki-extract.yml` workflow fires on `pull_request.closed`
when `merged == true`. It runs `wiki ingest` over the PR body, commit
messages, and the merged diff, producing one new page under
`.red/wiki/pages/<pr-number>-<slug>.md` summarising the decision the PR
encoded. The page is committed back to `main` on the same merge.

The wiki becomes a journal of merged decisions, not a manually-maintained
KB. The `.red/wiki/index.md` regenerates from `pages/` on each ingest so
the index never drifts.

### 3. On every PR: CI drift guard

A `red-memory-drift-guard.yml` workflow fires on every PR. It checks:

- If any file under `.red/adr/`, `.red/CONTEXT.md`, `.red/CONTEXT-MAP.md`,
  or `.red/contexts/**` changed, **then** a corresponding
  `memory ingest` audit-log entry (or commit-trailer marker like
  `Memory-Ingested: <sha>`) must exist on the head SHA. If missing, the
  workflow fails the check with a one-line explanation pointing at
  `/memory:ingest`.
- Codex contributors who cannot run the local hook still see the failure
  and can run the manual command before requesting review.

This closes the third loop: the markdown surfaces and the graph cannot
silently diverge across PRs.

### 4. Move `MEMORY.md` into the repo

The harness-level auto-memory (`~/.claude/projects/<project>/memory/`)
is per-machine and per-user. A new mirror at `.red/memory/MEMORY.md`
(versioned) becomes the canonical store; the harness path stays as a
**read-through symlink** so existing system-prompt loading keeps working.
Migration is one-shot: copy current entries into the repo, replace the
directory with a symlink, document the layout in `.red/agents/memory.md`.

Result: governance-level facts (English-only rule, label naming, AFK
stall enforcement) ship with the repo and are visible to every
contributor and every runner (Claude, Codex, bare terminal).

## Why

- **The plumbing is already there.** `config.json`'s hook flags, the
  graph store, the wiki dirs, and the extract/ingest/recall skills all
  exist. The missing piece is wiring them into the harness's actual hook
  system and into CI.
- **Decisions decay fast without graph capture.** ADR 0026 (interceptor
  hooks) was authored in this session; its rejected alternatives, the
  cargo cleanup mental model, and the defaults-first-user-after rule
  exist only in markdown. A `Stop` hook running `memory extract` would
  have captured them as `why_note` and `decision` nodes automatically.
  This is the most expensive gap to leave open because the ROI per
  extraction is highest on decision-dense sessions.
- **`PostToolUse` matchers scope cost.** Running `memory ingest` on every
  Edit is too noisy; running it only on `.red/{adr,wiki,CONTEXT*}` keeps
  the load proportional to the rate of structural decisions, not the
  rate of typing.
- **PR-merge is the natural wiki ingest point.** Merged PRs are the
  closest thing to "this decision is now reality." Pre-merge ingestion
  would pollute the wiki with abandoned drafts; post-merge keeps the wiki
  high-signal.
- **CI drift guard prevents the worst failure mode.** A repo where the
  ADRs say one thing and the graph says another is worse than no graph
  at all — it makes recall actively misleading. The drift guard catches
  the human-only case (`vim .red/adr/0099.md` without `/memory:ingest`).
- **Repo-versioned `MEMORY.md` aligns governance memory with the rest of
  the project.** Today, my refusal to write Portuguese in commits depends
  on a file that lives outside the repo. A new contributor cloning
  red-skills has no idea the rule exists until they violate it.
- **Codex parity preserved by graceful degradation.** Codex lacks
  `PreCompact`; SessionStart and Stop translate cleanly; `PostToolUse` on
  Codex maps to its closest event. CI guard catches whatever local hooks
  miss. The reference memory at `reference_codex_hooks.md` already
  documents the gap; this ADR honours it by not requiring `PreCompact`
  parity.

## Rejected alternatives

- **Leave `config.json` flags as the only source of truth and ask
  contributors to run the skills manually.** Rejected. This is what we
  have today, and ADR 0026's full decision tree did not land in the
  graph despite being a 1-hour decision-dense session. The expected
  failure mode is "rich graph for the operator who remembers, empty
  graph for everyone else."
- **Wire `PostToolUse` on every Edit/Write.** Rejected as noisy and
  expensive. Most edits are working-tree churn (test files, fixtures,
  generated artefacts) and contribute nothing to project memory. The
  scoped matcher on `.red/{adr,wiki,CONTEXT*}` captures the structural
  decisions and ignores the rest.
- **Make CI hard-require `memory ingest` for every PR regardless of
  files changed.** Rejected. Most PRs touch only code; failing them for
  not running an ingest would create alert fatigue. The drift guard
  only fires when the ADR/CONTEXT/wiki surfaces changed.
- **Replace markdown ADRs with graph-only decision nodes.** Rejected
  because ADRs need to be greppable, diffable, and reviewable in a PR
  by humans. The graph is a complement, not a replacement. The drift
  guard exists exactly because both stay.
- **Run `memory extract` on every `PostToolUse` instead of `Stop` /
  `PreCompact`.** Rejected. Extract is expensive (LLM call) and the
  transcript at a per-tool-call granularity has no narrative arc. Stop
  is the natural session boundary; PreCompact catches the
  long-conversation case.
- **Keep `MEMORY.md` outside the repo because it is "agent state."**
  Rejected. Governance memory (label naming, English-only, AFK stall
  enforcement) is project knowledge. Per-machine storage is the wrong
  scope. The harness symlink preserves backwards compatibility for
  Claude Code's loader without losing portability.
- **Use the GitHub Action to ingest into the graph directly.** Rejected
  for the first slice. The graph store is a local RedDB file; remote
  ingestion would require either pushing the binary store through git
  (huge merge conflicts) or a remote RedDB endpoint (out of scope).
  PR-merge populates the wiki (markdown, mergeable). Graph ingestion
  stays local via the on-Edit `PostToolUse` hook.

## Consequences

- `.claude/settings.json` gains four new hook entries alongside the
  branch-lock hook. The existing branch-lock wiring is untouched.
- The Memory plugin ships a small wrapper script (`.claude/hooks/memory/*`)
  that each hook entry calls, so the surface in `settings.json` stays
  declarative. The wrappers handle the best-effort-failure contract and
  the runner-detection cascade (same logic AFK already has — ADR 0015).
- A new `.github/workflows/red-memory-wiki-extract.yml` ships in the
  `dev` plugin under the `red-` workflow prefix (per the existing repo
  feedback memory). It depends on the `wiki ingest` CLI surface and runs
  with `contents: write` to commit the generated wiki page back to main.
- A new `.github/workflows/red-memory-drift-guard.yml` ships in the
  `dev` plugin. It is non-blocking on docs PRs (`type:prd`, `type:bug`
  with no structural change) and required on PRs touching the watched
  paths.
- The auto-memory `MEMORY.md` migrates from
  `~/.claude/projects/.../memory/` to `.red/memory/MEMORY.md` with a
  symlink left behind for backwards compatibility. The per-fact files
  follow the same migration. `.red/agents/memory.md` is updated to
  document the layout.
- `dev/skills/engineering/afk/scripts/lib/handoff.sh` (or its
  equivalent) gains an optional `<prior-context>` section in the
  handoff template, populated by `memory recall` against the issue
  title — this is the user-visible payoff of the closed loop and is a
  follow-up slice rather than first cut.
- The drift guard depends on `/memory:ingest` writing a stable audit
  marker (commit trailer or `.red/memory/.audit.log` entry); the marker
  contract gets formalised as part of this work.
- Codex parity: SessionStart/Stop/PostToolUse map; PreCompact stays as
  a Claude-only optimisation. The CI guard catches Codex contributors
  symmetrically.
- The Memory tier classification (ADR 0020) and the best-effort
  attempt-record contract (ADR 0017) are unchanged. This ADR is purely
  about *when* the writes happen, not *what* the schema looks like.
- Skill telemetry (ADR 0014) gains a new datapoint: how often each hook
  runs vs how often it succeeds vs how often the drift guard catches
  drift. This feeds the `/memory:skills-status` surface.
