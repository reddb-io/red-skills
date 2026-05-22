<div align="center">

```
   ██████╗ ███████╗██████╗     ███████╗██╗  ██╗██╗██╗     ██╗     ███████╗
   ██╔══██╗██╔════╝██╔══██╗    ██╔════╝██║ ██╔╝██║██║     ██║     ██╔════╝
   ██████╔╝█████╗  ██║  ██║    ███████╗█████╔╝ ██║██║     ██║     ███████╗
   ██╔══██╗██╔══╝  ██║  ██║    ╚════██║██╔═██╗ ██║██║     ██║     ╚════██║
   ██║  ██║███████╗██████╔╝    ███████║██║  ██╗██║███████╗███████╗███████║
   ╚═╝  ╚═╝╚══════╝╚═════╝     ╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚══════╝╚══════╝
```

### **Issues in. Merged PRs out.**

reddb.io's slash-command library for Claude Code, Codex, and friends.
**Ship while you sleep.**

**One-line install — auto-updates on every Claude Code startup:**

```
/plugin marketplace add reddb-io/red-skills && /plugin install dev@red-skills
```

[Install details](#install) · [`/afk`](#-afk--autonomous-issue-execution) · [Fleet mode](#fleet-mode--one-command-n-workers) · [Pipeline](#-the-pipeline-that-feeds-it) · [Codebase understanding](#-codebase-understanding-surface) · [Wiki](#-knowledge--your-private-llm-wiki) · [Reference](#reference)

```
   /start   ─▶   /to-prd   ─▶   /to-issues   ─▶   /triage   ─▶   ⚡ /afk
   refine        publish        slice into        write the      drain →
   the plan      a PRD          vertical          AGENT-BRIEF    test, merge,
                                slices                           close, repeat
```

**Highlights**

🚀 Fleet mode · 🤖 Claude + Codex runner cascade · 🪝 `.red/config.yaml` hooks & detectors (`cargo`, `gradle`)
📒 Canonical envelopes — the issue thread *is* the source of truth · 📊 Live monitor with 48 h sparkline
🎨 Project-aware statusline · 🔒 Safe-by-construction git (no `reset` / `stash` / `--force`)

</div>

> A reddb.io adaptation of [`mattpocock/skills`](https://github.com/mattpocock/skills) — same DNA, adapted for our reality, with an autonomous loop layered on top. Massive thanks to [@mattpocock](https://github.com/mattpocock); the original lives at [aihero.dev](https://www.aihero.dev/s/skills-newsletter). We pin upstream via `.upstream` and a daily workflow (`red-upstream-watch.yml`) opens an issue when it advances, so we cherry-pick what's worth taking.

---

## Install

### Claude Code — marketplace install

RedSkills ships as a Claude Code **plugin marketplace**. Add the marketplace once, install the `dev` plugin, and Claude Code pulls new commits at startup when marketplace auto-update is enabled.

Inside Claude Code:

```
/plugin marketplace add reddb-io/red-skills
/plugin install dev@red-skills
```

Use the skills as native slash commands:

```text
/setup-red-skills
/triage
/afk --once
```

From now on Claude Code checks `reddb-io/red-skills` at session start. Toggle the behaviour with `/plugin` → **Marketplaces** → select `red-skills` → **Enable auto-update**.

Force a refresh without restarting:

```
/plugin marketplace update red-skills
```

Remove:

```
/plugin uninstall dev@red-skills
/plugin marketplace remove red-skills
```

> ℹ️ Every push to `main` cuts a patch release on GitHub. New commits land on auto-update users at their next session — no action needed from them.

### Codex CLI — marketplace install

RedSkills also ships Codex plugin metadata. Codex reads `.agents/plugins/marketplace.json`, then loads the same `plugins/dev/skills/` tree through `plugins/dev/.codex-plugin/plugin.json`.

```bash
codex plugin marketplace add reddb-io/red-skills
```

Use the skills by name in Codex prompts. The convention is `$<skill>`:

```text
$setup-red-skills
$triage
$afk --once
```

Refresh later:

```bash
codex plugin marketplace upgrade red-skills
```

That upgrade refreshes the installed Codex plugin metadata, the skills tree, the
bundled hook manifests, and supporting files such as MCP/app definitions. On
the first Codex boot after installing or upgrading a marketplace that ships
hooks, Codex will ask you to revisit the plugin hooks before they run. Current
Codex builds list `plugin_hooks` as stable and enabled; older builds may require
this in `~/.codex/config.toml`:

```toml
[features]
plugin_hooks = true
```

Remove:

```bash
codex plugin marketplace remove red-skills
```

For Codex installs pinned to a local checkout, pass the local repo root instead:

```bash
codex plugin marketplace add ~/code/red-skills
```

### Verify Claude + Codex compatibility

Run this before a release or after upgrading either CLI:

```bash
./scripts/doctor-runners.sh
```

It validates the install metadata, checks shell syntax, verifies the Claude and Codex runner flags that `/afk` depends on, tests Codex marketplace registration in a temporary home directory, and checks manual symlink installs for all local agent skill directories.

<details>
<summary><strong>Alternatives — no auto-update</strong></summary>

Pick one of these only if the marketplace path doesn't fit (Gemini users, local hacking, or older agents without plugin marketplace support).

#### `npx skills` (Matt's installer)

```bash
npx skills@latest add reddb-io/red-skills
```

[skills.sh](https://skills.sh/reddb-io/red-skills) walks you through which skills to install and which coding agents to install them on. **No auto-update** — re-run the command to pull new versions. Same installer Matt uses for his upstream repo — credit to [@mattpocock](https://github.com/mattpocock).

#### Manual clone + symlinks

For local edits or `$<name>` access from Codex / Gemini CLI:

```bash
git clone git@github.com:reddb-io/red-skills.git ~/code/red-skills
cd ~/code/red-skills
./scripts/link-skills.sh         # symlinks every stable SKILL.md into local agent skill dirs
```

The script links into `~/.claude/skills`, `~/.agents/skills`, and `~/.codex/skills` so Claude Code, current Codex installs, and simple `$<name>` agents see the same working tree. **No auto-update.** Update later with `git pull && ./scripts/link-skills.sh`.

</details>

### Pick your agent

| Agent | Invocation | Notes |
|-------|------------|-------|
| **Claude Code** | `/afk`, `/wiki`, `/triage`, … | Native slash commands after `/plugin install dev@red-skills`. |
| **Codex CLI** | `$afk`, `$wiki`, `$triage`, … | Skill-name convention after `codex plugin marketplace add reddb-io/red-skills`. |
| **Gemini CLI / others** | `$afk`, etc. | Same `$<name>` convention. Works with any agent that can read local `SKILL.md` files and run bash. |

Teach Codex (or any non-Claude-Code agent) the convention by appending to `~/.codex/AGENTS.md`:

```markdown
## RedSkills

When the user types `$<name>` (e.g. `$afk`, `$wiki`, `$triage`), look up
`~/.agents/skills/<name>/SKILL.md`, `~/.codex/skills/<name>/SKILL.md`, or
`~/.claude/skills/<name>/SKILL.md` and follow it — usually that means running
`bash <skill-dir>/scripts/<entrypoint>.sh` with the documented flags.
Each SKILL.md is self-documenting; read it before invoking.
```

### Bootstrap a repo

Run once per target repo (from inside the repo):

```
/setup-red-skills
```

It walks you through five short decisions:

1. **Issue tracker.** GitHub Issues only — confirms `git remote -v` shows the right repo.
2. **Triage labels.** Maps the five canonical roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) to actual label strings.
3. **Domain docs.** Single-context (`.red/CONTEXT.md` + `.red/adr/`) or multi-context (`.red/CONTEXT-MAP.md` for monorepos).
4. **Workflows.** Installs `red-issues-needs-triage.yml` (auto-applies `needs-triage` so nothing slips past `/afk`).
5. **Token efficiency.** Strong recommendation to install [RTK](https://github.com/rtk-ai/rtk) before running `/afk` (details below).

Output: `.red/agents/*.md`, an `## Agent skills` block in `CLAUDE.md`/`AGENTS.md`, and `.github/workflows/red-*.yml`. All git-tracked. Re-run only to reconfigure from scratch.

### Before a long /afk run — install RTK

A multi-hour `/afk` session can burn a surprising fraction of its budget on **CLI chatter** — `pnpm install` progress lines, verbose `git status`, `gh` JSON dumps. [**RTK (Rust Token Killer)**](https://github.com/rtk-ai/rtk) is a transparent CLI proxy that rewrites those calls at the hook layer and returns only what the agent needs.

> **60–90% savings** on routine dev operations, with zero changes to how skills are written. Claude and Codex don't even see the rewrite.

```bash
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/main/install.sh | sh
rtk --version          # sanity-check the install
rtk gain               # token savings analytics; run after a day to see ROI
```

Strongly recommended before draining a non-trivial backlog with `/afk`. **Pays for itself in the first hour.**

> ⚠ **Name collision.** Another tool called `rtk` ([Rust Type Kit](https://github.com/reachingforthejack/rtk)) sometimes lands first on `PATH`. If `rtk gain` errors out, fix `PATH` so `rtk-ai/rtk` wins.

---

## ⚡ /afk — autonomous issue execution

```
$ /afk
[afk] worker: wK7M2
[afk] runner: claude (detected via pin)
[afk] unblocked 2 issue(s): #143 #144
[afk] 12 issue(s) queued (filter=all, runner=claude, cap=∞)
[afk] ▶ #142 wire OAuth callback
[afk] feedback: test:✓ typecheck:✓ lint:✓ build:✓
[afk] ✓ #142 done in 14m 12s — merge b3f2a91 — 1/12 (8%) — next: #143
[afk] ▶ #143 normalise error envelopes
[afk] feedback: test:✓ typecheck:✓ lint:✓ build:✓
[afk] ✓ #143 done in 9m 04s — merge 8e1d70c — 2/12 (17%) — next: #144
…
[afk] /afk done.
[afk] runner    : claude (12 issues)
[afk] duration  : 02:43:11
[afk] processed : 12 closed, 0 blocked, 0 failed
```

Point it at your `ready-for-agent` backlog and walk away. For each issue, `/afk`:

| Step | What happens | Why it matters |
|------|--------------|----------------|
| **Claim** | `ready-for-agent` → `running` via 3-layer lock (mkdir + gh pre-check + stale sweep) | Two parallel `/afk` runs never race on the same issue, even cross-checkout |
| **Isolate** | Spawns worktree in `.red/tmp/work-{worker}-i{N}/worktree/` | Primary checkout stays clean on `main`, always; gitignored so nothing leaks |
| **Brief** | Hands the issue's AGENT-BRIEF to Claude or Codex | The inner agent works from a contract, not the raw issue body |
| **Hooks** | Runs `pre-iteration` / `pre-merge` / `post-merge` / `post-iteration` per `.red/config.yaml` | Detectors (`cargo`, `gradle`) auto-set per-slot env to avoid build-lock contention |
| **Implement** | Inner agent codes via TDD inside the worktree | Failing test first, then code, then green |
| **Verify** | `pnpm test && typecheck && lint && build` | Two retries before flagging blocker |
| **Merge** | `git merge --no-ff` back into `main`, push over SSH | Auto-snapshot if primary is dirty; never `stash`/`reset`/`force` |
| **Envelope** | Posts a structured `<details data-attempt-status="…">` on the issue thread for every terminal event | Issue thread becomes the canonical ledger — retries on any machine see the full history |
| **Branch push** | On non-DONE attempts, pushes the branch to `afk-attempts/{worker}/{N}-{slug}` | Forensic diff visible on GitHub's compare view, even when nothing landed on `main` |
| **Close** | Validation comment, `gh issue close`, drop worktree | Per-issue summary; iter dir self-collects |
| **Watchdog** | Kills the pipeline tree if the inner agent emits a sentinel but the stream stays open | Survives the "bash polling loop hung the agent" failure mode |
| **Survive** | Hits a rate limit? Swaps runner mid-issue. Both out? Releases claim, exits 75 | You resume tomorrow, no lost work |

### Invocation modes

```bash
/afk                            # drain everything ready-for-agent
/afk --prd 42                   # drain just the children of PRD #42
/afk --issues 356,359,362       # explicit list, in argument order
/afk --runner claude            # pin a backend (default: claude first, codex fallback on exhaustion)
/afk -n 5                       # cap at five issues
/afk --once                     # supervised single iteration (debug mode)
/afk                            # run it again in another terminal — auto-parallel, no flag needed
/afk monitor                    # readonly live status board, aggregates every worker, second terminal
/afk fleet [N]                  # spawn a supervisor that maintains N workers (default 2) — respawn + circuit breaker
/afk fleet stop                 # graceful shutdown of the supervisor + auto-monitor cron
```

Every `/afk` invocation gets its own 4-char worker ID (e.g. `wK7M2`), so opening N terminals = N parallel workers with zero coordination — or use `/afk fleet 4` for a single command that supervises four. Label transitions on GitHub are atomic, so two workers can never claim the same issue.

### Live monitor

Every iteration writes atomic state to `.red/tmp/work-{worker}-i{N}/afk.state.json` and tees the inner agent's stdout into `afk.log` alongside it. Open a second terminal:

```
48h: ·▁··▁·▁·▁··█▁▁··▁·▁···▁·▁·▆▁▁··▁···▁▆·▁··▁▃▁·▃▁·  (35 closed, peak 5/h)

┌─ /afk monitor ─────────────────────────────────────────────┐
│ runner: claude         elapsed: 00:14:23   eta: ~01:20:00 │
│ done: 3 / 12 (25%)     blocked: 0          merged: 3      │
│                                                            │
│ ▶ #142 wire OAuth callback                                 │
│   worktree: .red/tmp/work-wK7M2-i142/worktree              │
│   stage: impl                                              │
│   last: writing tests for callback handler                 │
│                                                            │
│ queue: #143 #144 #145 #146 ...                             │
└────────────────────────────────────────────────────────────┘
```

The 48 h sparkline at the top aggregates `.red/state/afk-history.jsonl` across every worker — at-a-glance throughput. Compact one-line variant kicks in automatically when the monitor is piped, so it's safe to invoke inline from another agent.

Designed for terminals you leave open while you do something else. Or sleep. Under Claude Code, every worker spawn also schedules an auto-monitor cron that re-renders every 3 min and self-cancels when all workers exit. Under Codex, fleet launches the same supervisor and uses a read-only monitor agent when the Codex sub-agent UI is available; otherwise run `/afk monitor` or tail `.red/tmp/afk-supervisor.log`.

### Fleet mode — one command, N workers

`/afk` is trivially parallel — open N terminals and you get N workers, no flag needed. **Fleet mode** is the lazy version: one runner-portable supervisor maintains a target worker count, respawns crashes, and trips a per-slot circuit breaker when a slot dies too fast. Claude Code and Codex differ only in the monitor surface: Claude can schedule an auto-monitor cron, while Codex can show a read-only monitor agent or fall back to `/afk monitor` and logs.

```
                  ┌──────────────────────────────────────────┐
                  │  supervisor.sh    target=4    PID=98221   │
                  │  poll=15s   stall-threshold=10min         │
                  └────────┬──────────┬──────────┬──────────┬─┘
                           │          │          │          │
                       slot-1     slot-2     slot-3     slot-4
                        wK7M2      wQ3LP      w9RNX     ⛔ parked
                       claude     claude     claude    (5 deaths/90s)
                          │          │          │
                       #142       #143       #144
                       impl       tests      merge
```

```bash
/afk fleet 4               # spawn supervisor maintaining 4 workers
/afk fleet                 # default: 2
/afk fleet stop            # graceful: SIGTERM every worker, drop the pid file, tear down runner-specific monitor surface
```

- **Respawn.** A worker that exits cleanly because the queue drained is *not* respawned (no busy-loop on empty). A worker that crashes is respawned with backoff.
- **Circuit breaker.** ≥ 5 crashes within 90 s on the same slot ⇒ the slot is parked. Other slots keep working. Fleet stop clears parked state.
- **Trip sweep.** When a slot trips, the supervisor walks the iter dirs that worker owned, posts a `discarded` envelope on each open issue, and restores `ready-for-agent` so another worker picks them up.
- **Per-slot isolation.** Each slot exports `RED_AFK_SLOT=N` so detectors (cargo, gradle, …) can shard build directories per slot.

### Statusline

`/setup-red-skills` wires a project-aware statusline into Claude Code's bottom bar. One line, always-on:

```
red-skills (main) · Opus·high · 47k 24% · 🤖2 📋3 🙋1 +382 -45 #142
```

Project basename, git branch, model + effort, context tokens with a percent colour-coded by threshold, then a zero-suppressed AFK block — workers running, queue depth, ready-for-human count, diff against `main`, current issue numbers as OSC 8 hyperlinks to the GitHub thread. Opt out per-project with `statusline: false` in `.red/config.yaml`.

### Hooks & detectors (`.red/config.yaml`)

`/afk` runs four orchestrator phases (`pre-iteration`, `pre-merge`, `post-merge`, `post-iteration`) and two supervisor phases (`pre-spawn`, `post-exit`). Each phase fires three layers in order:

1. **Shipped detectors** — `cargo`, `gradle` and friends ship with the skill. When `Cargo.toml` is present, `cargo` sets `CARGO_TARGET_DIR=/opt/cargo-target/slot-${RED_AFK_SLOT}` so parallel workers don't deadlock on the same target directory.
2. **Project hooks** — drop a script under `.red/hooks/` and it runs after the shipped detectors. Same env-file protocol: write `KEY=value` lines to `$RED_AFK_HOOK_ENV_FILE` and the orchestrator inherits them for the next stage.
3. **Main hook** — the actual git/test/merge action.

Disable any of it with `.red/config.yaml`:

```yaml
afk:
  hooks:
    cargo: false           # disable the shipped cargo detector
    gradle: true
statusline: false           # quiet the bottom-bar AFK block
```

### Environment variables

Every env var the skill reads or exports is prefixed `RED_AFK_*`. Operator knobs are set in your shell rc, CI, or the `/afk fleet` invocation; the hook/detector contract is exported into each worker subshell by the supervisor and read by detectors under `detectors/` and any project hooks under `.red/hooks/`.

**Operator tunables** (set when invoking — `RED_AFK_TARGET=4 /afk fleet`):

| Variable | Default | Purpose |
|---|---|---|
| `RED_AFK_TARGET` | `2` | Worker count maintained by the fleet supervisor. |
| `RED_AFK_RUNNER` | `claude` | Runner used when no `--runner` flag, env sniff, or path sniff resolves first (last step of the detection cascade). `claude` or `codex`. |
| `RED_AFK_STAGGER_S` | `2` | Seconds between successive worker spawns at supervisor boot — avoids thundering-herd on git/gh. |
| `RED_AFK_POLL_S` | `15` | Supervisor health-check tick (sec). Lower = faster respawn, more CPU. |
| `RED_AFK_FAST_DEATH_S` | `30` | A slot dying in < N s counts toward the circuit breaker. |
| `RED_AFK_CIRCUIT_K` | `5` | Fast deaths in the window before a slot is parked. |
| `RED_AFK_CIRCUIT_WINDOW_S` | `90` | Sliding window for the circuit breaker (sec). |
| `RED_AFK_STALL_THRESHOLD_S` | `600` | Inactivity (sec) after which a slot is flagged `stalled` in the monitor — alive but no log progress. 10 min default. |
| `RED_AFK_PER_ISSUE_CAP` | `3` | Consecutive BLOCKED attempts (since the last human directive) before an issue is flipped `ready-for-agent` → `ready-for-human` and skipped at claim time. `0` or non-numeric falls back to `3`. Recover by adding a directive and manually relabelling back. |
| `RED_AFK_STALL_POLL_S` | `30` | Supervisor's stall-detector sampling cadence (sec). |
| `RED_AFK_WATCHDOG_GRACE_S` | `30` | Grace (sec) after the inner agent emits `<promise>DONE</promise>` before the orchestrator force-closes its stdout pipe (protects against runaway polling loops the inner agent forgot to bound). |
| `RED_AFK_MONITOR_COMPACT` | `0` | `1` → `/afk monitor` emits one line per worker and exits 0 (same as `--once`). For scripts and statusline integrations. |
| `RED_AFK_CARGO_TARGET_BASE` | `/opt/cargo-target` | Base path the shipped `cargo` detector shards under per slot — exports `CARGO_TARGET_DIR=${BASE}/slot-${RED_AFK_SLOT}`. |
| `RED_AFK_GRADLE_USER_HOME_BASE` | *(unset = detector off)* | Opt-in. When set, the shipped `gradle` detector exports `GRADLE_USER_HOME=${BASE}/slot-${RED_AFK_SLOT}`. Unset = no-op (deliberate — never claim a path on the host without consent). |

**Hook/detector contract** (exported into each worker subshell — read these from inside your `detectors/*.sh` or `.red/hooks/*.sh`):

| Variable | When set | What it carries |
|---|---|---|
| `RED_AFK_SLOT` | always | Slot index (`0`..`RED_AFK_TARGET-1`). Use to shard per-slot resources. |
| `RED_AFK_WORKER_ID` | always | `wXXXX` worker ID for this spawn. |
| `RED_AFK_RUNNER` | always | `claude` or `codex` — the resolved runner for this worker. |
| `RED_AFK_PLUGIN_DIR` | always | Absolute path to the installed afk skill dir (parent of `scripts/`). Use to source shipped helpers. |
| `RED_AFK_HOOK_ENV_FILE` | `pre-*` phases | Write `KEY=value` lines here; the orchestrator inherits them for the next stage. The detector / hook env-export channel. |
| `RED_AFK_ISSUE` | iteration phases | Issue number for the current iteration. |
| `RED_AFK_BRANCH` | iteration phases | Branch the worktree is on (`afk/{worker}/{N}-{slug}`). |
| `RED_AFK_ITER_DIR` | iteration phases | `.red/tmp/work-{id}-i{N}/` — the iteration directory. |
| `RED_AFK_STATE_FILE` | iteration phases | Absolute path to this iteration's `afk.state.json`. |
| `RED_AFK_ITER_STATUS` | `post-iteration` | Terminal status — `done` / `blocked` / `no-sentinel` / `merge-conflict`. |
| `RED_AFK_MERGE_BASE` | `pre-merge` | The `main` SHA we're merging onto. |
| `RED_AFK_MERGE_SHA` | `post-merge` | The merge commit SHA (DONE only). |
| `RED_AFK_DURATION_S` | `post-exit` | Worker wall-time in seconds. |
| `RED_AFK_EXIT_CODE` | `post-exit` | Worker exit code (0 = clean exit). |

Internal-only shell vars (`PROJECT_ROOT`, `ITER_DIR`, `RUNNER`, `WORKER_ID`, …) never cross the process boundary and are not part of the contract — don't rely on them from outside scripts.

### Canonical ledger — the issue thread *is* the record

Every terminal event of every attempt posts a single structured comment on the issue:

```html
<details data-attempt-status="blocked"><summary>worker `wK7M2` · status: blocked · duration: 2m5s · diff: +42 -10 · attempt: 1</summary>
  <details data-section="notes">…handoff Notes…</details>
  <details data-section="log">…last 50 lines of inner-agent stdout…</details>
</details>
```

Four statuses (`done`, `blocked`, `no-sentinel`, `merge-conflict`) with deterministic schema. Non-DONE attempts also push the branch to `afk-attempts/{worker}/{N}-{slug}` so the diff is reviewable on GitHub even though it never landed on `main`. Next attempt — on this machine or another — re-reads the envelope chain and feeds it to the inner agent as retry context. Cross-machine continuity, no hidden state.

### Steering a worker mid-flight — directive markers

Comments you post on the issue thread reach the inner agent on its **next attempt**, but only a marked comment carries *authority*. Wrap the part you want treated as a binding instruction in a `<details data-kind="directive">` block:

```html
<details data-kind="directive">
Keep `foo()` — don't rename it. Just deprecate it with a `@deprecated` JSDoc tag
and leave the body untouched.
</details>
```

The agent extracts the **verbatim content** of every such block and routes it to the authoritative `<human-guidance>` channel — one element per marker, so a single comment with two markers becomes two directives. Anything outside a marker (clarifying questions, observations, asides) lands in the advisory `<thread-discussion>` channel: visible to the agent but never authoritative, and never a reason to abort. Marker, not your GitHub login, is the authority gate — every orchestrator audit comment posts under the operator account too, so the wire can't tell humans from bots by author alone.

When sources disagree, the agent resolves by this precedence ladder (highest to lowest):

1. **`<human-guidance>`** — your marked directives (most recent wins among them)
2. **`<issue-body>`** — the brief, including HITL edits you paste into the body
3. **`<previous-attempts>`** — history, never authoritative
4. **`<thread-discussion>`** — advisory chatter, lowest authority

So a fresh directive that says "actually keep `foo()`" overrides an older acceptance criterion in the brief that said "rename `foo()`" — the disagreement *is* your resolution, not a contradiction the agent should flag.

### Safe by construction, not by hope

`/afk` enforces a strict allowlist on git: **no `reset`, no `rebase`, no `clean`, no `stash`, no `--force`, no HTTPS remotes**. Dirty primary checkouts get auto-snapshotted before merge. Merge conflicts that can't be auto-resolved release the worktree and flag the issue `ready-for-human` with the diff attached. SIGINT releases the claim and re-applies `ready-for-agent`, so a Ctrl-C never leaves an issue stranded.

→ [`afk/SAFETY.md`](./plugins/dev/skills/engineering/afk/SAFETY.md) is binding for the orchestrator *and* the inner agent.

---

## 🔁 The pipeline that feeds it

`/afk` is the last mile. The skills compose into the full loop:

```
  vague idea                       bug you hit                      something on fire
       │                                │                                  │
       │   /start                       │   /report-bug                    │   /urgent
       ▼                                ▼                                  ▼
   refined plan                  type:bug + needs-triage           priority:urgent +
       │                                │                          ready-for-agent
       │   /to-prd                      │   /triage                          │
       ▼                                ▼                                    │
   published PRD                  ready-for-agent  ◄──────────────── jumps queue
       │                                │                            (next /afk picks it
       │   /to-issues <PRD>             │                             first, ahead of
       ▼                                │                             --prd / --issues)
   children issues                      │
       │                                │
       │   /triage  (per child)         │
       ▼                                │
   ready-for-agent ─────────────────────┘
       │
       │   /afk                    Drain. Inner agent implements, tests pass,
       ▼                            merged, closed. Next iteration re-fetches
   shipped                          queue — `priority:urgent` always wins.
```

**Enter at any step.**
- Spec already written? Jump to `/to-issues`.
- Issues already triaged? Jump straight to `/afk`.
- Single feature, not a whole PRD? `/start` → `/to-issues` → `/afk` works fine.
- Bug report? `/report-bug` interviews you, files `type:bug + needs-triage`, then `/triage` writes the AGENT-BRIEF.
- Something on fire? `/urgent` skips triage entirely — `priority:urgent + ready-for-agent` direct, and `/afk` prepends urgents to its queue on every iteration so the next claim is yours.

The full issue lifecycle (`needs-triage` → `ready-for-agent` → `running` → `closed`, with `ready-for-human` and `needs-info` as branches) — including the ASCII state machine, the heartbeat protocol, and every label transition — lives in [`setup-red-skills/triage-labels.md`](./plugins/dev/skills/engineering/setup-red-skills/triage-labels.md).

### Nothing leaks

`/setup-red-skills` installs `red-issues-needs-triage.yml`, a GitHub Action that auto-applies `needs-triage` to every fresh issue with no labels. `/afk`'s startup straggler check warns you when unlabelled, `needs-triage`, or `needs-info` issues pile up. Belt **and** braces — the pipeline is hard to leak.

---

## 🗺 Codebase understanding surface

`/zoom-out` is the first Codebase understanding surface in the `dev` plugin. It is map-first: answers start with modules/layers, then relationships, critical paths, and risks/gaps, so you get orientation before raw detail.

When the optional `memory` plugin is initialized in Memory Graph mode and the graph has indexed content, `/zoom-out` is graph-aware. It may read graph neighbors and paths through the `dev` Memory bridge, interpret them into the map, and verify the explanation against current files. If Memory is absent, uninitialized, markdown-only, stale, empty, or failing, `/zoom-out` degrades to ordinary codebase exploration and still answers from the repo.

`/zoom-out` is read-only. It does not run `/memory:ingest`, reindex files, or write graph state. If graph indexing is absent or stale enough to matter, the answer can recommend that you explicitly run `/memory:ingest <path>` before a later zoom-out.

Boundaries:

| Surface | Use it for |
|---------|------------|
| `/zoom-out` | Map-first orientation over unfamiliar code; graph-aware when Memory Graph mode is ready. |
| `/memory:recall` | Search stored Memory notes or graph memory for relevant prior facts. |
| `/wiki query` | Ask over the private `.red/wiki/` knowledge cache and optionally save a synthesis page. |
| Future Ask surface | Direct question-first answers over project knowledge. This remains out of scope here. |

---

## 📚 Knowledge — your private LLM Wiki

```
$ /wiki ingest https://example.com/important-paper.pdf
[wiki] fetched → .red/wiki/raw/important-paper.md
[wiki] discussing key takeaways before writing pages…
[wiki] touched: pages/important-paper.md, pages/vannevar-bush.md, pages/associative-trails.md
[wiki] index.md and log.md updated.
```

Inspired by Karpathy's [LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). Instead of RAG re-deriving knowledge on every query, the agent **maintains** an incremental markdown wiki at `.red/wiki/` (gitignored — your private knowledge cache, never leaves the machine).

- **[`/wiki-init`](./plugins/dev/skills/knowledge/wiki-init/SKILL.md)** — one-time bootstrap. Three questions (domain, source types, solo vs team) and you have a schema, layout, and `## Agent skills` registration.
- **[`/wiki`](./plugins/dev/skills/knowledge/wiki/SKILL.md)** routes by verb:

| Verb | What it does |
|------|--------------|
| `ingest <url\|path>` | Fetches the source, writes a source page, updates entity/concept pages, surfaces contradictions |
| `query <question>` | Searches index + pages, synthesises (prose, table, Mermaid), optionally files the answer back as a `synthesis` page |
| `lint` | Health check: contradictions, stale pages, orphans, stubs, missing concepts, open gaps |

Pages are typed (`entity`, `concept`, `source`, `synthesis`) with YAML frontmatter, standard markdown links (no Obsidian wikilinks — GitHub-portable), and an append-only `log.md` so every operation is auditable.

→ Walkthroughs: [research wiki](./plugins/dev/skills/knowledge/wiki-init/examples/research.md) · [book-reading wiki](./plugins/dev/skills/knowledge/wiki-init/examples/book-reading.md)

---


## Philosophy

Small, sharp skills. They work with any model. Each one targets a specific failure mode of code agents:

| Failure mode | Use |
|--------------|-----|
| Agent didn't do what I want | [`/reflect`](./plugins/dev/skills/productivity/reflect/SKILL.md), [`/start`](./plugins/dev/skills/engineering/start/SKILL.md) |
| Agent is verbose, no shared vocabulary | `.red/CONTEXT.md` + [`/start`](./plugins/dev/skills/engineering/start/SKILL.md) |
| Code doesn't work | [`/tdd`](./plugins/dev/skills/engineering/tdd/SKILL.md), [`/diagnose`](./plugins/dev/skills/engineering/diagnose/SKILL.md) |
| Codebase turned into a mud ball | [`/to-prd`](./plugins/dev/skills/engineering/to-prd/SKILL.md), [`/zoom-out`](./plugins/dev/skills/engineering/zoom-out/SKILL.md), [`/improve-codebase-architecture`](./plugins/dev/skills/engineering/improve-codebase-architecture/SKILL.md) |
| I want it to run while I sleep | [`/afk`](./plugins/dev/skills/engineering/afk/SKILL.md) |

Composable. Boring on purpose where boring is enough. Sharp where it matters.

---

## Reference

<details>
<summary><strong>Engineering — daily code work</strong></summary>

| Skill | What it does |
|-------|--------------|
| **[afk](./plugins/dev/skills/engineering/afk/SKILL.md)** | Drains `ready-for-agent` issues in isolated worktrees. Claude/Codex runner cascade, fleet mode (`/afk fleet N`), pluggable detectors via `.red/config.yaml`, canonical attempt envelopes on the issue thread, 48h sparkline monitor, statusline integration. |
| **[diagnose](./plugins/dev/skills/engineering/diagnose/SKILL.md)** | Disciplined diagnosis: reproduce → minimise → hypothesise → instrument → fix → regression-test. |
| **[start](./plugins/dev/skills/engineering/start/SKILL.md)** | Grilling session that challenges your plan against the domain model; updates `.red/CONTEXT.md` and ADRs inline. |
| **[triage](./plugins/dev/skills/engineering/triage/SKILL.md)** | Moves issues through the triage state machine; writes the AGENT-BRIEF that `/afk` will consume. |
| **[report-bug](./plugins/dev/skills/engineering/report-bug/SKILL.md)** | Interview the user about a bug, then file a `type:bug needs-triage` issue on the tracker. Seeds from conversation context when invoked with no argument. |
| **[urgent](./plugins/dev/skills/engineering/urgent/SKILL.md)** | File a `priority:urgent` issue that bypasses `/triage` and jumps the head of the `/afk` queue, ahead of any `--prd N` / `--issues a,b,c` filter. Use when something is on fire. |
| **[improve-codebase-architecture](./plugins/dev/skills/engineering/improve-codebase-architecture/SKILL.md)** | Finds deepening opportunities in the codebase, informed by `.red/CONTEXT.md` and `.red/adr/`. |
| **[tdd](./plugins/dev/skills/engineering/tdd/SKILL.md)** | Red-green-refactor loop; one vertical slice at a time. |
| **[to-issues](./plugins/dev/skills/engineering/to-issues/SKILL.md)** | Breaks a plan, spec, or PRD into independently-grabbable issues via vertical slices. |
| **[to-prd](./plugins/dev/skills/engineering/to-prd/SKILL.md)** | Turns the current conversation into a PRD; publishes as a GitHub issue. |
| **[zoom-out](./plugins/dev/skills/engineering/zoom-out/SKILL.md)** | Map-first Codebase understanding; graph-aware when Memory Graph mode is ready, read-only when it is not. |
| **[prototype](./plugins/dev/skills/engineering/prototype/SKILL.md)** | Throwaway prototype — terminal app for state/logic, or UI variations toggleable from one route. |
| **[setup-red-skills](./plugins/dev/skills/engineering/setup-red-skills/SKILL.md)** | Per-repo config: issue tracker, triage label vocab, domain doc layout, RedSkills workflows, RTK. |

</details>

<details>
<summary><strong>Knowledge — incremental wiki</strong></summary>

| Skill | What it does |
|-------|--------------|
| **[wiki-init](./plugins/dev/skills/knowledge/wiki-init/SKILL.md)** | Bootstrap `.red/wiki/`, write the schema, gitignore artefacts, register under `## Agent skills`. |
| **[wiki](./plugins/dev/skills/knowledge/wiki/SKILL.md)** | `ingest` / `query` / `lint` — operate on the wiki. |

</details>

<details>
<summary><strong>Productivity — workflow</strong></summary>

| Skill | What it does |
|-------|--------------|
| **[reflect](./plugins/dev/skills/productivity/reflect/SKILL.md)** | Interviews you until every branch of the decision tree is resolved. |
| **[handoff](./plugins/dev/skills/productivity/handoff/SKILL.md)** | Compacts the current conversation into a handoff doc for the next agent. |
| **[write-a-skill](./plugins/dev/skills/productivity/write-a-skill/SKILL.md)** | Scaffolds new skills with proper structure and progressive disclosure. |

</details>

<details>
<summary><strong>Misc — niche utilities</strong></summary>

| Skill | What it does |
|-------|--------------|
| **[branch-lock](./plugins/dev/skills/misc/branch-lock/SKILL.md)** | Locks the agent to a branch and blocks it from switching away (agent-only pre-tool hook for Claude Code and Codex). |
| **[git-guardrails-claude-code](./plugins/dev/skills/misc/git-guardrails-claude-code/SKILL.md)** | Claude Code hooks that block destructive git commands. |
| **[migrate-to-shoehorn](./plugins/dev/skills/misc/migrate-to-shoehorn/SKILL.md)** | Migrates test files from `as` type assertions to `@total-typescript/shoehorn`. |
| **[scaffold-exercises](./plugins/dev/skills/misc/scaffold-exercises/SKILL.md)** | Creates exercise scaffolds with sections, problems, solutions. |
| **[setup-pre-commit](./plugins/dev/skills/misc/setup-pre-commit/SKILL.md)** | Configures Husky pre-commit with lint-staged, Prettier, type-check, tests. |

</details>

<details>
<summary><strong>Memory plugin — persistent memory (markdown-only · graph)</strong></summary>

The separate **`memory`** plugin gives agents a persistent, queryable memory that
survives `/clear` and crosses sessions. It lives on top of `dev` (requires it).
Two storage modes ship today — **markdown-only** (plain notes, zero engine
dependency) and **graph** (a typed knowledge graph over a per-project RedDB
store). Both keep hooks and MCP off — nothing auto-fires. Install `memory`
alongside `dev`, then run `memory init`.

| Skill | What it does |
|-------|--------------|
| **[init](./plugins/memory/skills/core/init/SKILL.md)** | Setup wizard. markdown-only writes `.red/memory/config.json` + `.red/memory/notes/`; graph also builds locally and provisions a per-project RedDB store at `.red/memory/graph.rdb`. Hooks off, MCP off. |
| **[store](./plugins/memory/skills/core/store/SKILL.md)** | `/memory:store <fact>` — save a fact (markdown note, or a deduped graph node). |
| **[recall](./plugins/memory/skills/core/recall/SKILL.md)** | `/memory:recall <query>` — ranked search over stored memory (notes, or the graph with supersede-aware, neighborhood-expanded results). |
| **[ingest](./plugins/memory/skills/core/ingest/SKILL.md)** | `/memory:ingest <path>` — walk a repo into the graph: code symbols + markdown structure with their edges (graph mode). |
| **[doctor](./plugins/memory/skills/core/doctor/SKILL.md)** | `/memory:doctor` — flag stale nodes (long-unaccessed, never recalled) and prune them after confirmation (graph mode). |
| **[export](./plugins/memory/skills/core/export/SKILL.md)** | `/memory:export` — export the graph to a navigable graph.html + graph.json + audit.md (graph mode). |

See [plugins/memory/README.md](./plugins/memory/README.md) and, for the RedDB
graph-write constraints, [ADR 0007](./.red/adr/0007-reddb-graph-writes-via-multi-model-dml.md).
Hybrid storage, the MCP server, the auto-firing hooks, and the `/afk` · `/triage`
· `/diagnose` integrations land in later slices.

</details>

<details>
<summary><strong>MCP servers — bundled tools</strong></summary>

| Server | What it does |
|--------|--------------|
| **[code-nav](./plugins/dev/mcp/code-nav/README.md)** | LSP-backed semantic navigation. Spawns the language server for each file type and exposes `workspace_symbols`, `goto_definition`, `find_references`, `document_symbols`, `hover` as MCP tools — IDE-grade symbol navigation on top of the agent's default search. Presets for TS/Go/Rust/Python; extend via `CODE_NAV_SERVERS`. Loads automatically with the `dev` plugin. |

</details>

---

## House conventions

- 🏷 **Labels are kebab-case or `prefix:value`.** `needs-triage`, `ready-for-agent`, `running`, `priority:high`, `slice:afk`, `prd:42`. No uppercase, no spaces.
- 🤖 **Workflows shipped by RedSkills start with `red-`.** `red-issues-needs-triage.yml`, `red-upstream-watch.yml`.
- 🐙 **Issues and PRDs live on GitHub.** No local-markdown tracker, no GitLab/Jira/Linear fallback.
- 📁 **Artefacts live under `.red/`.** Context glossary, ADRs, agent docs, the wiki, the `/afk` state file. Keeps consumer repos clean.
- 🔒 **SSH for git, every time.** No HTTPS remotes. `/afk` refuses to start otherwise.

---

## License

MIT, inherited from [`mattpocock/skills`](https://github.com/mattpocock/skills). See [LICENSE](./LICENSE).
