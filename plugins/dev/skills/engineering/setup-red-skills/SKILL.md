---
name: setup-red-skills
description: >-
  The one authorized creator of a repo's `.red/` directory and the only way to
  enable RedSkills plugins (dev, memory, brain) in a project (ADR 0067).
  RedSkills hooks are installed globally on every agent but stay fully inert in
  any directory without a `.red/config.yaml` whose
  `plugins.<name>.enabled: true` opts that plugin in. This skill prompts which
  plugins to enable, creates `.red/`, writes the activation flags, and sets up
  `## Agent skills`/`## Development workflow` blocks in AGENTS.md/CLAUDE.md plus
  `.red/agents/`. Run to turn RedSkills on in a repo, to enable/disable a
  plugin, before first use of `to-tickets`, `to-spec`, `triage`, `diagnose`,
  `tdd`, `improve-codebase-architecture`, `zoom-out`, or `/go`, or if those
  skills appear to be missing context.
disable-model-invocation: true
---

# Setup RedSkills

**Scaffold the per-repo configuration that the engineering skills assume — this skill is the only thing authorized to create `.red/`.** NEVER create `.red/` outside this skill — plugins stay fully inert in any directory whose `.red/config.yaml` is missing or lacks an explicit `plugins.<name>.enabled: true`.

Scaffold includes:

- **Plugin activation** — the per-directory gate (ADR 0067): which RedSkills plugins (`dev`, `memory`, `brain`) are allowed to run here.
- **Issue tracker** — GitHub Issues (the only supported option, reddb.io policy)
- **Triage labels** — the strings used for the canonical triage roles and label families
- **Domain docs** — where `.red/CONTEXT.md` and ADRs live, and the consumer rules for reading them
- **Workflows** — GitHub Actions shipped by RedSkills (installed under the `rs-*` prefix), e.g. auto-label fresh issues with `needs-triage` so nothing slips past `/triage` and `/afk`
- **Token efficiency** — strongly recommend installing [RTK](https://github.com/rtk-ai/rtk) to cut 60–90% of dev-operation tokens via a transparent CLI proxy
- **Runtime launcher** — optionally install a host-level `red-skills-dev` shim so Claude Code, Codex, and opencode can invoke the same dev runtime without relying on CLI-specific plugin-root env vars
- **Command guards** — configure the repo-owned `.red/config.yaml` policy that the globally-installed Claude Code, Codex, and opencode hook proxies enforce
- **Development workflow** — teach agents the `.red/tmp` worktree rules, preserve the primary checkout for the human, and route one-off concrete work through `/go` (ADR 0081)

This is a prompt-driven skill, not a deterministic script. Explore, present what you found, confirm with the user, then write.

## Process

### 1. Explore

Look at the current repo to understand its starting state. Read whatever exists; don't assume:

- `git remote -v` and `.git/config` — is this a GitHub repo? Which one?
- `AGENTS.md` and `CLAUDE.md` at the repo root — does either exist? Is there already an `## Agent skills` section in either?
- `.red/CONTEXT.md` and `.red/CONTEXT-MAP.md` at the repo root
- `.red/adr/` — the single root ADR sequence (there are no nested `.red/` subtrees)
- `.red/agents/` — does this skill's prior output already exist?
- `.red/config.yaml` — does it exist? Which plugins are already enabled (`plugins.<name>.enabled: true`)? Is the canonical `plugins.dev.lock.primary-branch` flag already set? Is `command_guard` already configured, and under which scopes (`global`, `main`, `worktree`, or legacy `deny`)?
- `AGENTS.md` and `CLAUDE.md` — does either already have a `## Development workflow` section?

### 2. Present findings and ask

Summarise what's present and what's missing. Then walk the user through the sections **one at a time** — present a section, get the user's answer, then move to the next. Don't dump all sections at once.

Assume the user does not know what these terms mean. Each section starts with a short explainer (what it is, why these skills need it, what changes if they pick differently). Then show the choices and the default.

**Section A0 — Plugin activation — ask first (the per-directory gate)**

> Explainer: RedSkills plugins (`dev`, `memory`, `brain`) install their hooks **globally** on every agent (Claude Code, Codex, opencode), but they must only act in repos that explicitly opt in. Each plugin's hook launcher checks, before doing anything, whether the current directory's `.red/config.yaml` sets `plugins.<name>.enabled: true` (ADR 0067, strict opt-in). No `.red/config.yaml` → every RedSkills plugin stays fully inert here (no bundle fetch, no hooks, no side effects). A `plugins.<name>` block alone is **not** enough — the flag must be the explicit `true`.

Ask the user which plugins to enable in this repo (multi-select; `dev` is the usual baseline):

- **dev** — the engineering stack: `/afk`, `/triage`, `/go`, model-tier routing, branch-lock, statusline. Enabling it is what makes the rest of this setup meaningful; default yes.
- **memory** — governed operational memory (recall/store/graph). After enabling, run `/memory:init` to choose the storage mode. Default no.
- **brain** — the agentic command-center context. Default no.

Record the choice; it drives the `plugins:` block written in step 4. Disabling a previously-enabled plugin is also valid here — set its flag to absent/`false`. Creating `.red/` (if missing) is authorized by this section; never create it just to host one of the other sections — if the user enables no plugins, write nothing.

**Section A — Issue tracker.**

> Explainer: In every reddb.io repo, issues and Specs **always** live on GitHub Issues. Skills like `to-tickets`, `triage`, `to-spec`, and `qa` call `gh issue create` / `gh issue edit` directly. There is no local fallback and no support for other trackers — this is a project-wide policy.

Confirm that `git remote` points to a GitHub repo, then proceed with the `issue-tracker-github.md` seed. If the repo has no GitHub remote, stop and ask the user to configure one before continuing.

**Section B — Triage label vocabulary.**

> Explainer: When the `triage` skill processes an incoming issue, it moves it through a state machine — needs evaluation, waiting on reporter, ready for an AFK agent to pick up, ready for human decision/resolution, dependency-blocked, or won't fix. To do that, it needs to apply labels (or the equivalent in your issue tracker) that match strings *you've actually configured*. If your repo already uses different label names (e.g. `bug:triage` instead of `needs-triage`), map them here so the skill applies the right ones instead of creating duplicates. Labels should belong to a clear family: current state, permanent type, priority, relationship/dependency, or operational diagnostic.

The canonical state roles:

- `needs-triage` — maintainer needs to evaluate
- `needs-info` — waiting on reporter
- `ready-for-agent` — fully specified, AFK-ready (an agent can pick it up with no human context)
- `ready-for-human` — needs human decision/resolution before it can proceed or be delegated
- `blocked:dependency` — waiting on other issues (via `req:N` edges); never pages a human; auto-unblocks when the last dep closes
- `wontfix` — will not be actioned

Do not provision or preserve labels outside the accepted label families; HITL/AFK routing is represented by `ready-for-human` / `ready-for-agent`.

Default: each role's string equals its name. Ask the user if they want to override any. If their issue tracker has no existing labels, the defaults are fine.

**Section C — Domain docs.**

> Explainer: Some skills (`improve-codebase-architecture`, `diagnose`, `tdd`) read a `.red/CONTEXT.md` file to learn the project's domain language, and `.red/adr/` for past architectural decisions. They need to know whether the repo has one global context or multiple (e.g. a monorepo with separate frontend/backend contexts) so they look in the right place.

Confirm the layout:

- **Single-context** — one `.red/CONTEXT.md` + `.red/adr/` at the repo root. Most repos are this.
- **Multi-context** — `.red/CONTEXT-MAP.md` at the root pointing to per-context `.red/CONTEXT.md` files (typically a monorepo).

**Section D — Workflows.**

> Explainer: RedSkills ships GitHub Actions workflows that close gaps in the manual flow. The most important one is `red-issues-needs-triage.yml` — it auto-applies the `needs-triage` label to any newly opened or reopened issue that has no labels yet, so fresh reports never slip past `/triage` and never sit invisible to `/afk` (which only drains `ready-for-agent`). When we **install** a workflow into a consumer repo we rename it `red-skills-<name>.yml` so the adopter can tell our workflows from its own CI. The rename is filename-only — see [WORKFLOWS.md](./WORKFLOWS.md) for the full three-prefix convention (`reusable-*` reusables / `rs-*` installed copies / `red-*` red-skills' own CI).

This section is a **menu, not an all-or-nothing**. Ask the user which workflows they want and, for any opt-in lane, which configs — never install a lane the user didn't pick. Default each workflow as marked below and let them override.

Confirm with the user:

- Install `red-issues-needs-triage.yml` (verbatim — name unchanged; it is a standalone `red-*` copy-installable, not a reusable caller) into `.github/workflows/`? Default: yes.
- Does the `needs-triage` label exist in the issue tracker? If not, create it (`gh label create needs-triage --description "Maintainer needs to evaluate"`).
- Does the `runner-error` label exist? If not, create it (`gh label create runner-error --color B60205 --description "AFK supervisor circuit-tripped; runner was misconfigured"`). The `/afk` fleet supervisor falls back to creating it on the fly during a circuit trip, but provisioning it here keeps colour/description consistent across repos.
- Does the `blocked:dependency` label exist? If not, create it (`gh label create blocked:dependency --color D4C5F9 --description "Waiting on other issues (req:N edges); auto-unblocks when the last dependency closes"`). `req:N` edge labels are created on demand by `/to-tickets` (`gh label create req:<n>`) like `spec:N`, so they need no upfront provisioning.
- Provision the typed **blocked-reason** labels `/afk` applies to describe *why* an iteration stopped (it falls back to creating each on the fly, so this only keeps colour/description consistent): `gh label create blocked:quota`, `blocked:runner-transient`, `blocked:merge-conflict`, `blocked:ci`, `blocked:spec`, `blocked:validation`, `blocked:crashed`, `blocked:policy`, `blocked:stalled`, `blocked:infra` (suggested colour `E99695`, descriptions per the *Blocked Reasons* table in triage-labels). These are descriptive (added alongside the routing label) — see triage-labels.
- Does the `landing:manual` label exist? If not, create it idempotently (`gh label create landing:manual --color FBCA04 --description "AFK runs the full pipeline + opens the PR, then holds for a human's merge click (no auto-merge)"`). A `ready-for-agent` issue carrying it stays in the autonomous `/afk` lane but parks `ready-for-human` with the open PR instead of auto-merging — so agent-codable slices that must not be auto-merged (e.g. changes to AFK's own landing/claim machinery) no longer have to be hand-dispatched via `/go` (issue #1049). `/triage` may set it at brief-writing time; `/hitl`'s **delegable-manual-landing** disposition routes an issue here.

**Autonomous AFK execution lane (opt-in — default NO).** Beyond auto-triage, RedSkills can run `/afk` itself **from GitHub Actions** — one attempt per issue, opening a PR with no human at a terminal (the "offline" / headless lane, ADR 0059/0062). This is a bigger commitment than auto-triage, so it is **off by default**. Offer it, defaulting to no:

- Install the AFK Actions lane (the caller, as `rs-afk-attempt.yml`) into `.github/workflows/`? **Default: no.** Explain the prerequisites before a yes, and ask which configs to use:
  - **Secrets** — one OpenCode auth key as a repo secret. Ask which provider the user runs, then which key to wire (first set wins): `MINIMAX_API_KEY` (`minimax/<model>`), `OPENAI_API_KEY` (`openai/<model>`), or `OPENROUTER_API_KEY` (`openrouter/<vendor>/<model>`). Without one the lane fires but the agent fails auth. **Public-repo gotcha:** org secrets are *not* shared with public repos by default — if the repo is public, the key must be a **repo secret** or an org secret whose "Repository access" includes this repo, else it resolves empty with no error. Full secret guide: [`../afk/actions-lane.md`](../afk/actions-lane.md#configuring-secrets-per-provider).
  - **Model** — ask which `<provider>/<model>` slug to pin in the caller (e.g. `minimax/MiniMax-M3`), or leave empty to use the repo's `.red/config.yaml` model config.
  - **Trust gate** — ask for the allowlisted issue-author + label-applier logins (you set them). Public repos: keep the allowlist to yourself + your bot.
  - **Triggers** — ask whether they want the manual `workflow_dispatch` caller, the `issues: labeled` auto-trigger, or both. Fires on `ready-for-agent` (labeled, or an issue opened already carrying it) / manual dispatch.
  - Full reference: [`../afk/actions-lane.md`](../afk/actions-lane.md).

Future RedSkills workflows land in this same step, following the same three-prefix convention ([WORKFLOWS.md](./WORKFLOWS.md)).

**Section E — Token efficiency (strongly recommended).**

> Explainer: A huge fraction of an agent's token budget gets burned on noisy CLI output — `git status` on a dirty branch, `pnpm install` with hundreds of progress lines, `gh pr list` with verbose JSON, `ls` on a `node_modules` you forgot to ignore. [RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk) is a transparent CLI proxy that rewrites those commands at the hook layer to return only what the agent actually needs. Typical savings: **60–90%** on routine dev operations, with no changes to how skills are written — the rewrite is invisible to Claude/Codex.

Strong recommendation: install before running `/afk` for any non-trivial backlog. A long `/afk` run on a busy repo can blow through a session's quota on `pnpm`/`git`/`gh` chatter alone. RTK pays for itself in the first hour.

Walk the user through the install and agent integration:
```bash
# install
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/main/install.sh | sh

# verify (should print a version, NOT "command not found")
rtk --version

# install hook/instructions for the current assistant family when supported
rtk init --show
rtk init --hook-only --auto-patch        # Claude Code local hook only
rtk init --codex                         # Codex/AGENTS.md + RTK.md integration

# baseline analytics — run after a day of usage to see savings
rtk gain
rtk gain --history
```

Three things to verify after install:

1. **No name collision.** Another tool called `rtk` (Rust Type Kit, `reachingforthejack/rtk`) sometimes lands first on `PATH`. If `rtk gain` says "command not found" or prints unrelated output, fix `PATH` so `rtk-ai/rtk` wins.
2. **Hook or instructions are active.** `rtk init --show` should report a configured hook/RTK.md for the active assistant. For Claude Code, confirm the hook by running `git status` once and checking `rtk gain --history` shows the call.
3. **Fallback explicit mode works.** If the active agent cannot use RTK hooks, teach it to call `rtk git status`, `rtk vitest`, `rtk tsc`, `rtk pnpm`, `rtk test`, and `rtk err` directly for noisy commands.

`rtk discover` scans recent transcripts for missed savings opportunities — useful periodically to spot commands the hook should be rewriting but isn't yet.

**Section E1 — Runtime launcher (strongly recommended).**

> Explainer: `CLAUDE_PLUGIN_ROOT`, `CODEX_PLUGIN_ROOT`, and similar variables are plugin/hook environment variables. They are not guaranteed in the interactive shell where an agent runs `/afk`, `/go`, `/dashboard`, or `/requeue`. Setting those names globally is brittle because they point at versioned plugin-cache directories and can become stale after an update. The cross-CLI surface should be a stable command, not a global fake plugin-root variable.

Offer to install the host-level runtime shim:

```bash
bash plugins/dev/skills/engineering/setup-red-skills/scripts/install-runtime-shim.sh
```

The script writes `${XDG_BIN_HOME:-$HOME/.local/bin}/red-skills-dev`. The shim:

- prefers the active CLI plugin-root env var when the host exposes one;
- otherwise finds the latest installed dev plugin under `~/.codex/plugins/cache/red-skills/dev/*` or `~/.claude/plugins/cache/red-skills/dev/*`;
- falls back to the latest warmed dev bundle under `~/.cache/red-skills/bundles/`;
- forwards all arguments to the dev runtime, so skills can say `red-skills-dev go ...`, `red-skills-dev dashboard`, or `RED_AFK_RUNNER=codex red-skills-dev monitor --once`;
- stores no secrets and does not replace the `.red/config.yaml` opt-in gate.

After installing, verify:

```bash
command -v red-skills-dev
red-skills-dev dashboard --json
```

If `command -v` cannot find it, add `${XDG_BIN_HOME:-$HOME/.local/bin}` to the shell `PATH`. Do not export `CLAUDE_PLUGIN_ROOT` or `CODEX_PLUGIN_ROOT` globally as a substitute.

**Section F — RedSkills statusline (optional).**

> Explainer: RedSkills has one shared statusline producer in the dev bundle: the `statusline` subcommand reads each worker's `.red/tmp/workers/*/*/afk.state.json`, filters by `kill -0` liveness, sums diffstats locally, and caches GitHub-derived counts for 60 s to stay under the ~100 ms refresh budget. Host adapters differ. Claude Code can run that producer through a command-backed `statusLine`, so it can show live worker count, queue depth, and aggregated diffstat at a glance. Codex currently exposes native `tui.status_line` footer widgets instead of a command hook; under Codex, use `$setup-statusline` to inspect or configure the footer and rely on `/afk monitor` for the live AFK block.

Decide whether to wire it up for this project:

- **Skip when** the per-project plugin config (`.red/config.yaml`) sets `afk.statusline: false`. Detect with `grep -qE '^[[:space:]]*statusline:[[:space:]]*false[[:space:]]*$'` on the `afk:` block (or use `yq` if available). When skipped, log a one-line notice (`afk.statusline: false in .red/config.yaml — skipping statusline wiring`) and move on.
- **Skip when** a `statusLine` entry is already present in `.claude/settings.json`. Do **not** overwrite — log a one-line notice (`statusLine already configured in .claude/settings.json — leaving as-is`) so the user can decide. Idempotency rule: re-running `/dev:setup-red-skills` must never clobber a hand-edited statusline.
- **Otherwise** write the entry into `.claude/settings.json` (create the file if missing, merge with existing keys via `jq` if present):

  ```json
  {
    "statusLine": {
      "type": "command",
      "command": "sh -c 'b=$(ls -1 \"$HOME\"/.cache/red-skills/bundles/dev-*.bundle.min.mjs 2>/dev/null | sort -V | tail -1); [ -z \"$b\" ] && b=$(ls -1 \"$HOME\"/.claude/plugins/cache/red-skills/dev/*/skills/engineering/afk/bin/afk.mjs 2>/dev/null | sort -V | tail -1); [ -n \"$b\" ] && exec node \"$b\" statusline'",
      "refreshInterval": 5
    }
  }
  ```

  Do **not** use `$CLAUDE_PLUGIN_ROOT` here: Claude Code does not export it (nor `$CLAUDE_PROJECT_DIR`) to a `statusLine` command — only to plugin hooks and MCP/LSP subprocesses — so that form expands to an empty path and renders blank. The command above is **cached-bundle-first**: it resolves the **highest-version already-fetched runtime bundle** (`ls -1 …/.cache/red-skills/bundles/dev-*.bundle.min.mjs | sort -V | tail -1` — `sort -V` picks the highest semver, NOT `ls -t | head -1` which picks newest-by-mtime and can resolve an OLD version when an older dir was touched/re-extracted more recently), and only falls back to the launcher `afk.mjs` from the plugin cache when no bundle is cached yet (first-ever install). Resolving the cached bundle directly keeps the network out of the hot path: since ADR 0038 the launcher does a synchronous download on a cold cache, so pointing the statusline straight at it means **every plugin update** blanks the line until the new bundle is fetched. The cached-bundle-first form keeps showing the last good bundle across updates without pinning a version. The project root is read from `workspace.project_dir` in the JSON Claude Code pipes on stdin (no argument needed). This subsection writes only the Claude Code adapter; the shared producer remains host-agnostic, and Codex's adapter lives in the `setup-statusline` skill because it edits global `~/.codex/config.toml` rather than repo-local `.claude/settings.json`.

The script is no-op outside `/afk` sessions (it prints nothing when no live workers exist), so leaving the statusline wired up in non-AFK projects is harmless.

**Section G — `.red/config.yaml` template (automatic).**

> Explainer: `.red/config.yaml` is the per-project knob file that `/afk` and friends read at runtime. It holds the project's fallback runner, default fleet target, and per-detector opt-outs. The schema is documented by the loader shipped in PRD #16 and is forward-compatible (unknown keys are ignored). A fresh repo should land with a *commented* template of every v1 knob so the user discovers the available settings without reading docs — the file is a no-op until lines are uncommented.

No user decision here for the template itself — the skill scaffolds it whenever the file is missing. The one piece that is **not** optional is the `plugins:` activation block from Section A0: the file must carry `plugins.<name>.enabled: true` for each plugin the user enabled, or the globally-installed hooks stay inert (ADR 0067). If `.red/config.yaml` already exists, leave its existing content alone (any prior edits are project state — never clobbered) **except** for surgically adding/updating the `plugins.<name>.enabled` flags to match Section A0 — that targeted merge is the sole allowed exception to the no-clobber rule, since it is the whole point of re-running this skill to enable a plugin. See step 4 for the write rule.

The template carries a **commented `afk.backpressure`** block (#430 / PRD #429): an ordered list of shell commands (`npm run test`, `npm run lint`, …) AFK runs after the built-in feedback gate on every successful iteration — DONE and salvaged no-sentinel alike — where any non-zero exit blocks the merge and parks the issue to `ready-for-human`. It ships commented (a no-op until uncommented). **One optional offer:** when scaffolding a fresh template into a repo whose root (or a clearly primary package) `package.json` declares `test` and/or `lint` scripts, surface them and ask whether to pre-fill the block with the matching `npm run <script>` (or `pnpm`) lines — uncommented — instead of the commented placeholder. Only pre-fill on explicit confirmation; otherwise leave the block commented. Never touch an existing `.red/config.yaml` (the clobber rule wins over this offer).

**Section G1 — Command guards (offer-only).**

> Explainer: RedSkills ships the maximum practical shell-command hook coverage for each supported CLI (Claude Code, Codex, and opencode). Those hooks are **proxy guarantees**, not the policy source: they extract the command and cwd, find the repo root, read `.red/config.yaml`, then evaluate `command_guard`. This keeps AFK workers and the main interactive session on the same repo-owned policy, and it keeps per-CLI hook files as thin adapters instead of places where safety rules drift.

Built-in invariant: when `plugins.dev.enabled: true`, the dev proxy always enforces the RedSkills worktree boundary before any repo-authored `command_guard` rule runs. Agent-created `git worktree add` destinations must resolve under the repo's `.red/tmp/`, and branch-moving commands in the primary checkout (`git switch`, `git checkout <branch>`, `git checkout -b`, `git switch -c`, `gh pr checkout`) are blocked so interactive work starts with `git worktree add .red/tmp/work-<slug> -b <branch> ...`. This invariant is not written into `command_guard` and has no example defaults to copy; it is part of enabling `dev`.

Offer to configure additional `command_guard` rules now. Default: **no extra active rules** unless the user confirms specific commands. Examples are examples only — do not write them as defaults.

Explain the scopes:

- `global` — blocks in both the main session and `/afk`/`/go` worktrees.
- `main` — blocks only in the primary interactive session scope. This does **not** mean the Git branch named `main`.
- `worktree` — blocks only in RedSkills runtime worktrees under `.red/tmp/`, including AFK workers.
- `deny` — legacy alias for `global`; keep it readable but prefer writing new config as `global`.

Explain the matcher forms:

- Bare strings match the exact command, a command prefix, or a command suffix at a shell-command boundary.
- Bare strings with `*`, `?`, or `[` are Bash globs.
- Explicit modes are `regex:<pattern>`, `re:<pattern>`, `prefix:<literal>`, `suffix:<literal>`, `exact:<literal>`, and `glob:<pattern>`.

When the user wants starter examples, present a draft like this and let them edit before writing:

```yaml
command_guard:
  global:
    - "rm -Rf /*"
    - "git stash"
  main:
    - "git rebase"
    - "git checkout -b"
  worktree:
    - "git clean"
```

Do not write the example blindly. The right policy is repo-specific.

**Section H — Development workflow.**

> Explainer: RedSkills' interactive dev loop assumes agents work from isolated worktrees, leave the primary checkout's branch alone, push their branch early, and land via a PR — with one-off concrete work dispatched through `/go` rather than hand-rolled worktrees. With `plugins.dev.enabled: true`, the shell proxy already blocks agent-created worktrees outside `.red/tmp/` and branch movement in the primary checkout. Turning on `plugins.dev.lock.primary-branch: true` in `.red/config.yaml` also activates the branch-lock compatibility flag used by older adapters and base-pinning integrations; the runtime folds it onto the legacy `dev.lock.primary-branch` accessor for back-compat. The shared development-workflow injector writes the same `## Development workflow` rules into both `AGENTS.md` and `CLAUDE.md`, updating an existing block in place on rerun.

Confirm with the user:

- Activate the development workflow? Default: yes.
- This sets the canonical `plugins.dev.lock.primary-branch: true` flag in `.red/config.yaml`.
- This writes or updates `## Development workflow` in both `AGENTS.md` and `CLAUDE.md` via the shared injector.
- Recap that one-off concrete work is dispatched with `/go "<demand>"` (worktree + gate + PR handled by the engine), and that hand-worked branches land via a normal PR.

**Section I — Hook scripts from repo signals (offer-only).**

> Explainer: RedSkills hook scripts run at fixed AFK lifecycle points — before merging (`pre_merge`), after merging (`post_merge`), etc. — letting you gate or react to each iteration without editing the AFK runtime. Rather than asking you to configure these from scratch, this step scans your repo for concrete signals (a `package.json` with test/lint scripts, a `Makefile`, a Slack webhook env var, and so on) and offers to seed matching `red-*.sh` scripts into `.red/hooks/<point>/`. Each confirmed script is also registered in `.red/config.yaml` under `afk.hooks.<point>`. Nothing is written without explicit confirmation; no existing script is ever overwritten; nothing is `git add`ed. If no signals are found, this section is silent — absence of signals means no offer.

Scan for concrete repo signals in this order:

1. **`package.json` `scripts.*`** — look for keys named `test`, `typecheck`, `type-check`, `lint`, `build`, `e2e`, or `test:e2e`. Infer the package manager from the first lockfile found (`pnpm-lock.yaml` → `pnpm run`, `yarn.lock` → `yarn run`, else `npm run`). `e2e`/`test:e2e` goes to `post_merge` (too costly as a pre-merge gate); all others go to `pre_merge`.
2. **`Makefile`** — parse top-level targets; offer `pre_merge` hooks for any target named `test`, `check`, `verify`, `lint`, or `build`.
3. **`Cargo.toml`** — offer a `pre_merge` hook running `cargo test` (the built-in default handles Rust worktree isolation; this adds the test run).
4. **`build.gradle` / `build.gradle.kts`** — offer a `pre_merge` hook running `./gradlew check` (the built-in default handles Gradle isolation; this adds the check step).
5. **`.husky/` directory** — offer a `pre_merge` hook running `npx lint-staged`.
6. **`.pre-commit-config.yaml`** — offer a `pre_merge` hook running `pre-commit run --all-files`.
7. **`.env.example`** — scan for `SLACK_WEBHOOK_URL` or `SLACK_INCOMING_WEBHOOK`; offer a `post_merge` Slack notification hook.

If no signals are detected, skip this section entirely — present no table, ask nothing.

If signals are found, present an offer table listing each suggestion:

| Point | Script | Signal |
|-------|--------|--------|
| `pre_merge` | `.red/hooks/pre_merge/red-run-tests.sh` | `package.json scripts.test = "vitest"` |
| `pre_merge` | `.red/hooks/pre_merge/red-lint.sh` | `package.json scripts.lint = "eslint ."` |
| `post_merge` | `.red/hooks/post_merge/red-slack-notify.sh` | `SLACK_WEBHOOK_URL in .env.example` |

Ask the user which to confirm (all, none, or pick by number). Skip the offer for any path that already exists — log a notice and move on (no-clobber, no overwrite, no second ask).

### 3. Confirm and edit

Show the user a draft of:

- The `## Agent skills` block to add to whichever of `CLAUDE.md` / `AGENTS.md` is being edited (see step 4 for selection rules)
- The contents of `.red/agents/issue-tracker.md`, `.red/agents/triage-labels.md`, `.red/agents/domain.md`
- The Section H development-workflow changes: `plugins.dev.lock.primary-branch: true` plus the canonical `## Development workflow` block for `AGENTS.md` and `CLAUDE.md`
- The Section G1 command-guard changes if the user accepted them: the exact `command_guard` block or scoped entries that will be written to `.red/config.yaml`

Let them edit before writing.

### 4. Write

**No-clobber rule (governs every write below).** Never overwrite, rewrite, or reorder content in a file this skill did not just create: if a target already exists, skip it, log a one-line notice, and move on — no second ask, and never `git add` on the user's behalf. Two surgical merges are the *only* exceptions, flagged at the steps that own them: updating `plugins.<name>.enabled` flags in an existing `.red/config.yaml`, and appending a missing `tmp/`/`state/` line to an existing `.red/.gitignore`. (Copied workflow YAML is the one "ask, don't silently skip" case — diff and ask first.)

**Pick the file to edit:**

- If `CLAUDE.md` exists, edit it.
- Else if `AGENTS.md` exists, edit it.
- If neither exists, ask the user which one to create — don't pick for them.

Never create `AGENTS.md` when `CLAUDE.md` already exists (or vice versa) — always edit the one that's already there.

If an `## Agent skills` block already exists in the chosen file, update its contents in-place rather than appending a duplicate. Don't overwrite user edits to the surrounding sections.

The block:

```markdown
## Agent skills

### Issue tracker

[one-line summary of where issues are tracked]. See `.red/agents/issue-tracker.md`.

### Triage labels

[one-line summary of the label vocabulary]. See `.red/agents/triage-labels.md`.

### Domain docs

[one-line summary of layout — "single-context" or "multi-context"]. See `.red/agents/domain.md`.
```

Then write the three docs files using the seed templates in this skill folder as a starting point:

- [issue-tracker-github.md](./issue-tracker-github.md) — GitHub issue tracker (the only option)
- [triage-labels.md](./triage-labels.md) — label mapping
- [domain.md](./domain.md) — domain doc consumer rules + layout

If the user accepted Section D, copy each standalone `red-*.yml` template the user picked from this skill folder's `workflows/` into `.github/workflows/` of the consumer repo **verbatim — keep the `red-*` filename, do not rename** (e.g. `workflows/red-issues-needs-triage.yml` → `.github/workflows/red-issues-needs-triage.yml`): standalone copy-installables keep their `red-*` prefix, only reusable **callers** get renamed to `rs-*` (AFK lane below). Don't overwrite an existing file — diff and ask first. Then ensure both `needs-triage` and `runner-error` labels exist via `gh label create` if missing (`gh label create runner-error --color B60205 --description "AFK supervisor circuit-tripped; runner was misconfigured"`).

**If the user opted into the autonomous AFK execution lane** (Section D, default no), additionally:

1. Copy [`../afk/examples/rs-afk-attempt.yml`](../afk/examples/rs-afk-attempt.yml) to `.github/workflows/rs-afk-attempt.yml` in the consumer repo (installed name is `rs-*`; the `uses:` ref inside still points at the `reusable-afk-attempt.yml` reusable — leave it). Don't overwrite an existing file — diff and ask first.
2. Edit `allowlist_authors` and `allowlist_label_actors` to the maintainer login(s) the user named (the trust gate; keep it short on public repos).
3. Apply the trigger choice from Section D: keep `workflow_dispatch` for a manual caller, the `issues: labeled` auto-trigger, or both. (The reusable's own `if:` gate auto-triggers on `ready-for-agent` even when only the dispatch caller exists.)
4. Set the `model:` input to the slug the user picked (e.g. `minimax/MiniMax-M3`), or leave it empty to fall back to the repo's `.red/config.yaml` model config.
5. Print the secret-setup guidance — the lane needs one OpenCode auth key; do **not** set it for them (secrets are the user's to provision): `gh secret set MINIMAX_API_KEY --repo OWNER/REPO` (or `OPENAI_API_KEY` / `OPENROUTER_API_KEY`; first set wins). **Public-repo gotcha:** if the repo is public, an *org* secret resolves empty unless its "Repository access" includes this repo — prefer a repo secret, or widen the org secret's access. Point them at [`../afk/actions-lane.md`](../afk/actions-lane.md#configuring-secrets-per-provider) for the per-provider table + auth precedence + the `model` slug.
6. Note that the lane will not fire until both a secret is set (and reaching the repo) and an issue carries `ready-for-agent` from an allowlisted actor.

Scaffold `.red/config.yaml` (Section G), writing the Section A0 activation flags:

1. If `.red/config.yaml` already exists at the repo root, apply the **plugin-flags exception** to the no-clobber rule: surgically add/update the `plugins.<name>.enabled` flags to match the Section A0 choice (add a `plugins:` block or `plugins.<name>:` child if missing; set `enabled: true` for enabled plugins; remove the flag or set `false` for ones the user turned off), touch nothing else, and log `.red/config.yaml present — merged plugin activation flags, left the rest as-is`.
2. Otherwise, ensure `.red/` exists (this section is the authorized creator) and copy [config-template.yaml](./config-template.yaml) to `.red/config.yaml`, then set the top `plugins:` block's `enabled` flags to match Section A0 (the template ships with `plugins.dev.enabled: true` as the baseline and `memory`/`brain` commented — uncomment/flip per the choice). The rest of the template is a fully-commented snapshot of every v1 knob the AFK config loader (`apps/dev/src/core/config.ts`) reads, so it stays a no-op until the user uncomments a line — including the commented `command_guard` and `afk.backpressure` blocks.
3. **Self-ignore `.red/`'s ephemeral state.** Whenever `.red/` exists (fresh scaffold or pre-existing), make the directory protect itself so `.red/tmp` and `.red/state` never get committed regardless of the repo-root `.gitignore`. Write `.red/.gitignore` if it is **missing** with exactly:

   ```gitignore
   # Generated by /setup-red-skills — local AFK/runtime state, never committed.
   tmp/
   state/
   ```

   If `.red/.gitignore` already **exists**, apply the **gitignore-append exception**: append whichever of the two patterns (`tmp/`, `state/`) is missing, and never rewrite or reorder existing lines. Keep tracked `.red` content (`config.yaml`, `contexts/`, `adr/`, `agents/`) committable — only `tmp/` and `state/` are ignored. Do **not** `git add` `.red/.gitignore` (step 5 — the user controls when `.red/` lands in git).
4. **Backpressure pre-fill offer (only on a fresh scaffold).** Read the repo-root (or primary package) `package.json`; if it declares `test` and/or `lint` scripts, surface them and ask whether to pre-fill `afk.backpressure` with the matching `npm run <script>` (or `pnpm run <script>`) lines, uncommented. On explicit yes, replace the commented `backpressure:` placeholder with the confirmed list; otherwise leave it commented. Skip silently when no such scripts exist. This step never runs when `.red/config.yaml` already existed (step 1 wins).
5. **Command guard write (only when Section G1 was explicitly accepted).** Update `.red/config.yaml` with the confirmed `command_guard` policy. If the file is fresh, replace the commented placeholder with the confirmed block. If the file already existed, merge only the accepted `command_guard.global`, `command_guard.main`, and/or `command_guard.worktree` entries, appending without duplicates and preserving unrelated content. If a legacy `command_guard.deny` block exists, leave it intact unless the user explicitly approved migrating it to `global`.
6. Do **not** `git add` or commit `.red/config.yaml` or `.red/.gitignore` — the user controls when they land in git.

If the user accepted Section H, activate the development workflow:

1. Invoke the shared injector rather than hand-editing the rules block. From a source checkout, run `pnpm --filter @reddb-io/dev dev inject-development-workflow --root <repo-root>`. From an installed plugin, run the bundled AFK entrypoint with `inject-development-workflow --root <repo-root>` (for example, `node ../afk/bin/afk.mjs inject-development-workflow --root <repo-root>` from this skill folder). The command writes both `AGENTS.md` and `CLAUDE.md`, creates `.red/config.yaml` if still missing, and sets `plugins.dev.lock.primary-branch: true`.
2. If the command is unavailable, make the same changes manually: add or update the canonical `plugins:` → `dev:` → `lock:` block in `.red/config.yaml` so `primary-branch` is `true`, then upsert the canonical `## Development workflow` block in both `AGENTS.md` and `CLAUDE.md`. Never append a duplicate block; update the existing section in place. Leave any legacy top-level `dev.lock.*` keys untouched; `/doctor --fix` owns that migration.
3. In the recap, explicitly point the user at `/go` for one-off concrete work, and at a normal PR for a hand-worked worktree branch that is already committed and pushed.

If the user accepted Section F, wire the statusline:

1. Check the opt-out: if `.red/config.yaml` exists and contains an `afk:` block with `statusline: false`, log `afk.statusline: false in .red/config.yaml — skipping statusline wiring` and skip the rest of this step.
2. Check for an existing `statusLine` key in `.claude/settings.json`. If one is present, log `statusLine already configured in .claude/settings.json — leaving as-is` and skip the rest of this step.
3. Otherwise, ensure `.claude/` exists and write/merge the `statusLine` block above into `.claude/settings.json`. Use `jq` for the merge when the file already has unrelated keys; create a fresh file containing only `statusLine` when missing.

If the user confirmed any hook scripts from Section I:

1. For each confirmed suggestion, ensure `.red/hooks/<point>/` exists (create the directory; `.red/` is already authorized by Section A0 — subdirectories under it are permitted).
2. Write `.red/hooks/<point>/<name>` with the script content. Per the no-clobber rule, if the file already exists, skip it silently — log `.red/hooks/<point>/<name> already exists — not overwriting` and move on.
3. Update `.red/config.yaml`: add the script path under the `afk.hooks.<point>:` list. Use the relative-to-root form `bash .red/hooks/<point>/<name>` as the command string. If the key already has entries, append without duplicating; if missing, add it. The `afk:` → `hooks:` → `<point>:` nesting matches the config-template structure.
4. Do **not** `git add` any of the written files or the updated config.

Script content for each signal type (all open with `#!/usr/bin/env bash` + `set -euo pipefail`):

- `red-run-tests.sh` (`pre_merge`): `<pm> run test`
- `red-typecheck.sh` (`pre_merge`): `<pm> run typecheck` (or `type-check` per the detected key)
- `red-lint.sh` (`pre_merge`): `<pm> run lint`
- `red-build.sh` (`pre_merge`): `<pm> run build`
- `red-e2e.sh` (`post_merge`): `<pm> run e2e` (or `test:e2e` per the detected key)
- `red-make-<target>.sh` (`pre_merge`): `make <target>`
- `red-cargo-test.sh` (`pre_merge`): `cargo test`
- `red-gradle-check.sh` (`pre_merge`): `./gradlew check`
- `red-lint-staged.sh` (`pre_merge`): `npx lint-staged`
- `red-pre-commit.sh` (`pre_merge`): `pre-commit run --all-files`
- `red-slack-notify.sh` (`post_merge`):

  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  # Post-merge Slack notification. Set SLACK_WEBHOOK_URL before running /afk.
  [ -z "${SLACK_WEBHOOK_URL:-}" ] && exit 0
  curl -sf -X POST "$SLACK_WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "{\"text\":\"AFK merged issue #${RED_AFK_ISSUE:-?} on ${RED_AFK_REPO:-repo}\"}"
  ```

### 5. Sweep existing issues

If the repo already has open issues, the new label vocabulary won't apply itself. Help the user backfill so `/triage` and `/afk` see a coherent state.

Run `gh issue list --state open --limit 200 --json number,title,labels` and group:

- **Unlabelled / missing triage role** — candidates for `needs-triage`
- **Labelled with legacy names** — map to the canonical vocabulary from Section B
- **Labels outside the accepted families** — remove them; do not map historical routing labels to another label
- **Already correct** — skip

Skip the sweep entirely if `gh issue list` returns 0 open issues.

Present the grouping to the user as a compact table (number, title, current labels, proposed labels) and ask for batch approval. Don't apply per-issue — one confirmation, then loop `gh issue edit <n> --add-label ... --remove-label ...`. If the list is large (>30), offer to do only the first N and stop.

Never close, reassign, or edit issue bodies in this step — labels only.

### 6. Done

Tell the user the setup is complete, which plugins are now enabled here (and that all other directories stay inert until they run this skill there too), and which engineering skills will now read from these files. If they enabled **memory** or **brain**, point them at the next step — `/memory:init` to pick a storage mode, or the brain setup — since enabling only authorizes the plugin to run; its own init configures it. Mention they can edit `.red/agents/*.md` directly later, and that one-off concrete work should be dispatched with `/go` (backlog via `/afk`, parked issues via `/requeue`). Re-run this skill to enable or disable a plugin, switch issue trackers, or restart from scratch.
