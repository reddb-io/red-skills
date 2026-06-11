---
name: setup-red-skills
description: Sets up `## Agent skills` and `## Development workflow` blocks in AGENTS.md/CLAUDE.md plus `.red/agents/` and `.red/config.yaml`, so the engineering skills know this repo's GitHub Issues setup, triage label vocabulary, domain doc layout, and interactive dev-loop rules. Run before first use of `to-issues`, `to-prd`, `triage`, `diagnose`, `tdd`, `improve-codebase-architecture`, `zoom-out`, or `/ship` — or if those skills appear to be missing context about the issue tracker, triage labels, domain docs, or dev workflow.
disable-model-invocation: true
---

# Setup RedSkills

Scaffold the per-repo configuration that the engineering skills assume:

- **Issue tracker** — GitHub Issues (the only supported option, reddb.io policy)
- **Triage labels** — the strings used for the canonical triage roles and label families
- **Domain docs** — where `.red/CONTEXT.md` and ADRs live, and the consumer rules for reading them
- **Workflows** — GitHub Actions shipped by RedSkills (all prefixed `red-`), e.g. auto-label fresh issues with `needs-triage` so nothing slips past `/triage` and `/afk`
- **Token efficiency** — strongly recommend installing [RTK](https://github.com/rtk-ai/rtk) to cut 60–90% of dev-operation tokens via a transparent CLI proxy
- **Development workflow** — activate the primary-branch guard, teach agents the isolated-worktree rules, and route interactive landing through `/ship`

This is a prompt-driven skill, not a deterministic script. Explore, present what you found, confirm with the user, then write.

## Process

### 1. Explore

Look at the current repo to understand its starting state. Read whatever exists; don't assume:

- `git remote -v` and `.git/config` — is this a GitHub repo? Which one?
- `AGENTS.md` and `CLAUDE.md` at the repo root — does either exist? Is there already an `## Agent skills` section in either?
- `.red/CONTEXT.md` and `.red/CONTEXT-MAP.md` at the repo root
- `.red/adr/` and any `src/*/.red/adr/` directories
- `.red/agents/` — does this skill's prior output already exist?
- `.red/config.yaml` — is `dev.lock.primary-branch` already set?
- `AGENTS.md` and `CLAUDE.md` — does either already have a `## Development workflow` section?

### 2. Present findings and ask

Summarise what's present and what's missing. Then walk the user through the sections **one at a time** — present a section, get the user's answer, then move to the next. Don't dump all sections at once.

Assume the user does not know what these terms mean. Each section starts with a short explainer (what it is, why these skills need it, what changes if they pick differently). Then show the choices and the default.

**Section A — Issue tracker.**

> Explainer: In every reddb.io repo, issues and PRDs **always** live on GitHub Issues. Skills like `to-issues`, `triage`, `to-prd`, and `qa` call `gh issue create` / `gh issue edit` directly. There is no local fallback and no support for other trackers — this is a project-wide policy.

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

> Explainer: RedSkills ships GitHub Actions workflows that close gaps in the manual flow. The most important one is `red-issues-needs-triage.yml` — it auto-applies the `needs-triage` label to any newly opened or reopened issue that has no labels yet, so fresh reports never slip past `/triage` and never sit invisible to `/afk` (which only drains `ready-for-agent`). All RedSkills workflows are prefixed `red-` so they're easy to identify alongside the host project's own CI.

Confirm with the user:

- Install `red-issues-needs-triage.yml` into `.github/workflows/`? Default: yes.
- Does the `needs-triage` label exist in the issue tracker? If not, create it (`gh label create needs-triage --description "Maintainer needs to evaluate"`).
- Does the `runner-error` label exist? If not, create it (`gh label create runner-error --color B60205 --description "AFK supervisor circuit-tripped; runner was misconfigured"`). The `/afk` fleet supervisor falls back to creating it on the fly during a circuit trip, but provisioning it here keeps colour/description consistent across repos.
- Does the `blocked:dependency` label exist? If not, create it (`gh label create blocked:dependency --color D4C5F9 --description "Waiting on other issues (req:N edges); auto-unblocks when the last dependency closes"`). `req:N` edge labels are created on demand by `/to-issues` (`gh label create req:<n>`) like `prd:N`, so they need no upfront provisioning.
- Provision the typed **blocked-reason** labels `/afk` applies to describe *why* an iteration stopped (it falls back to creating each on the fly, so this only keeps colour/description consistent): `gh label create blocked:quota`, `blocked:runner-transient`, `blocked:merge-conflict`, `blocked:spec`, `blocked:validation`, `blocked:crashed`, `blocked:policy`, `blocked:stalled`, `blocked:infra` (suggested colour `E99695`, descriptions per the *Blocked Reasons* table in triage-labels). These are descriptive (added alongside the routing label) — see triage-labels.

**Autonomous AFK execution lane (opt-in — default NO).** Beyond auto-triage, RedSkills can run `/afk` itself **from GitHub Actions** — one attempt per issue, opening a PR with no human at a terminal (the "offline" / headless lane, ADR 0059/0062). This is a bigger commitment than auto-triage, so it is **off by default**. Offer it, defaulting to no:

- Install the AFK Actions lane (`red-afk-attempt.yml`) into `.github/workflows/`? **Default: no.** Explain the prerequisites before a yes:
  - **Secrets** — an OpenCode auth key as a repo secret (`MINIMAX_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`; first set wins). Without one the lane fires but the agent fails auth.
  - **Trust gate** — only allowlisted issue authors + label-appliers can drive a run (you set the logins). Public repos: keep the allowlist to yourself + your bot.
  - **Triggers** — fires on `ready-for-agent` (labeled, or an issue opened already carrying it) / manual dispatch.
  - Full reference: [`../afk/actions-lane.md`](../afk/actions-lane.md).

For the complete `red-*` workflow catalogue (which are adopter-installable vs. red-skills' own CI), see [WORKFLOWS.md](./WORKFLOWS.md).

Future RedSkills workflows will land in this same step. Filename prefix `red-` is mandatory.

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

**Section F — `/afk` statusline (optional).**

> Explainer: When `/afk` is draining the queue, the Claude Code statusline can surface live worker count, queue depth, and aggregated diffstat at a glance — so the user doesn't need to run `/dev:afk monitor` in a side terminal. The plugin's AFK bundle exposes a `statusline` subcommand that reads each worker's `.red/tmp/workers/*/*/afk.state.json`, filters by `kill -0` liveness, sums diffstats locally, and caches GitHub-derived counts for 60 s to stay under the ~100 ms refresh budget.

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

  Do **not** use `$CLAUDE_PLUGIN_ROOT` here: Claude Code does not export it (nor `$CLAUDE_PROJECT_DIR`) to a `statusLine` command — only to plugin hooks and MCP/LSP subprocesses — so that form expands to an empty path and renders blank. The command above is **cached-bundle-first**: it resolves the **highest-version already-fetched runtime bundle** (`ls -1 …/.cache/red-skills/bundles/dev-*.bundle.min.mjs | sort -V | tail -1` — `sort -V` picks the highest semver, NOT `ls -t | head -1` which picks newest-by-mtime and can resolve an OLD version when an older dir was touched/re-extracted more recently), and only falls back to the launcher `afk.mjs` from the plugin cache when no bundle is cached yet (first-ever install). Resolving the cached bundle directly keeps the network out of the hot path: since ADR 0038 the launcher does a synchronous download on a cold cache, so pointing the statusline straight at it means **every plugin update** blanks the line until the new bundle is fetched. The cached-bundle-first form keeps showing the last good bundle across updates without pinning a version. The project root is read from `workspace.project_dir` in the JSON Claude Code pipes on stdin (no argument needed). This is **Claude Code only**; Codex has no command-backed statusline — see the `setup-statusline` skill for the Codex `tui.status_line` path.

The script is no-op outside `/afk` sessions (it prints nothing when no live workers exist), so leaving the statusline wired up in non-AFK projects is harmless.

**Section G — `.red/config.yaml` template (automatic).**

> Explainer: `.red/config.yaml` is the per-project knob file that `/afk` and friends read at runtime. It holds the project's fallback runner, default fleet target, and per-detector opt-outs. The schema is documented by the loader shipped in PRD #16 and is forward-compatible (unknown keys are ignored). A fresh repo should land with a *commented* template of every v1 knob so the user discovers the available settings without reading docs — the file is a no-op until lines are uncommented.

No user decision here for the template itself — the skill scaffolds it whenever the file is missing. If `.red/config.yaml` already exists, leave it alone (any prior edits are project state — never clobbered). See step 4 for the write rule.

The template carries a **commented `afk.backpressure`** block (#430 / PRD #429): an ordered list of shell commands (`npm run test`, `npm run lint`, …) AFK runs after the built-in feedback gate on every successful iteration — DONE and salvaged no-sentinel alike — where any non-zero exit blocks the merge and parks the issue to `ready-for-human`. It ships commented (a no-op until uncommented). **One optional offer:** when scaffolding a fresh template into a repo whose root (or a clearly primary package) `package.json` declares `test` and/or `lint` scripts, surface them and ask whether to pre-fill the block with the matching `npm run <script>` (or `pnpm`) lines — uncommented — instead of the commented placeholder. Only pre-fill on explicit confirmation; otherwise leave the block commented. Never touch an existing `.red/config.yaml` (the clobber rule wins over this offer).

**Section H — Development workflow.**

> Explainer: RedSkills' interactive dev loop assumes agents work from isolated worktrees, leave the primary checkout's branch alone, push their branch early, and hand landing to `/ship`. The primary-branch guard already ships dormant; turning on `dev.lock.primary-branch: true` in `.red/config.yaml` activates it. The shared development-workflow injector writes the same `## Development workflow` rules into both `AGENTS.md` and `CLAUDE.md`, updating an existing block in place on rerun.

Confirm with the user:

- Activate the development workflow? Default: yes.
- This sets `dev.lock.primary-branch: true` in `.red/config.yaml`.
- This writes or updates `## Development workflow` in both `AGENTS.md` and `CLAUDE.md` via the shared injector.
- Recap that `/ship` is the landing command for interactive work after the branch is pushed.

### 3. Confirm and edit

Show the user a draft of:

- The `## Agent skills` block to add to whichever of `CLAUDE.md` / `AGENTS.md` is being edited (see step 4 for selection rules)
- The contents of `.red/agents/issue-tracker.md`, `.red/agents/triage-labels.md`, `.red/agents/domain.md`
- The Section H development-workflow changes: `dev.lock.primary-branch: true` plus the canonical `## Development workflow` block for `AGENTS.md` and `CLAUDE.md`

Let them edit before writing.

### 4. Write

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

If the user accepted Section D, copy each `workflows/red-*.yml` template from this skill folder into `.github/workflows/` of the consumer repo. Don't overwrite existing files with the same name — diff and ask first. Then ensure both `needs-triage` and `runner-error` labels exist via `gh label create` if missing (`gh label create runner-error --color B60205 --description "AFK supervisor circuit-tripped; runner was misconfigured"`).

**If the user opted into the autonomous AFK execution lane** (Section D, default no), additionally:

1. Copy [`../afk/examples/red-afk-attempt-caller.yml`](../afk/examples/red-afk-attempt-caller.yml) to `.github/workflows/red-afk-attempt.yml` in the consumer repo. Don't overwrite an existing file — diff and ask first.
2. Edit `allowlist_authors` and `allowlist_label_actors` to the maintainer login(s) the user named (the trust gate; keep it short on public repos).
3. Print the secret-setup guidance — the lane needs one OpenCode auth key as a repo secret; do **not** set it for them (secrets are the user's to provision): `gh secret set MINIMAX_API_KEY` (or `OPENAI_API_KEY` / `OPENROUTER_API_KEY`; first set wins). Point them at [`../afk/actions-lane.md`](../afk/actions-lane.md) for the auth precedence + the `model` slug (e.g. `minimax/MiniMax-M2`).
4. Note that the lane will not fire until both a secret is set and an issue carries `ready-for-agent` from an allowlisted actor.

Scaffold `.red/config.yaml` (Section G, no user decision):

1. If `.red/config.yaml` already exists at the repo root, leave it untouched and log a one-line notice (`.red/config.yaml already present — leaving as-is`). Do **not** diff, merge, or overwrite — any existing content is project state.
2. Otherwise, ensure `.red/` exists and copy [config-template.yaml](./config-template.yaml) verbatim to `.red/config.yaml`. The template is a fully-commented snapshot of every v1 knob the AFK config loader (`apps/dev/src/core/config.ts`) reads from `.red/config.yaml`, so the file is a no-op until the user uncomments a line — including the commented `afk.backpressure` block.
3. **Backpressure pre-fill offer (only on a fresh scaffold).** Read the repo-root (or primary package) `package.json`; if it declares `test` and/or `lint` scripts, surface them and ask whether to pre-fill `afk.backpressure` with the matching `npm run <script>` (or `pnpm run <script>`) lines, uncommented. On explicit yes, replace the commented `backpressure:` placeholder with the confirmed list; otherwise leave it commented. Skip silently when no such scripts exist. This step never runs when `.red/config.yaml` already existed (step 1 wins).
4. Do **not** `git add` or commit the file — the user controls when it lands in git.

If the user accepted Section H, activate the development workflow:

1. Invoke the shared injector rather than hand-editing the rules block. From a source checkout, run `pnpm --filter @reddb-io/dev dev inject-development-workflow --root <repo-root>`. From an installed plugin, run the bundled AFK entrypoint with `inject-development-workflow --root <repo-root>` (for example, `node ../afk/bin/afk.mjs inject-development-workflow --root <repo-root>` from this skill folder). The command writes both `AGENTS.md` and `CLAUDE.md`, creates `.red/config.yaml` if still missing, and sets `dev.lock.primary-branch: true`.
2. If the command is unavailable, make the same changes manually: add or update the top-level `dev:` block in `.red/config.yaml` so `dev.lock.primary-branch` is `true` (nested: `lock:` → `primary-branch: true`), then upsert the canonical `## Development workflow` block in both `AGENTS.md` and `CLAUDE.md`. Never append a duplicate block; update the existing section in place.
3. In the recap, explicitly point the user at `/ship` as the landing command after an interactive worktree branch has been committed and pushed.

If the user accepted Section F, wire the statusline:

1. Check the opt-out: if `.red/config.yaml` exists and contains an `afk:` block with `statusline: false`, log `afk.statusline: false in .red/config.yaml — skipping statusline wiring` and skip the rest of this step.
2. Check for an existing `statusLine` key in `.claude/settings.json`. If one is present, log `statusLine already configured in .claude/settings.json — leaving as-is` and skip the rest of this step.
3. Otherwise, ensure `.claude/` exists and write/merge the `statusLine` block above into `.claude/settings.json`. Use `jq` for the merge when the file already has unrelated keys; create a fresh file containing only `statusLine` when missing.

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

Tell the user the setup is complete and which engineering skills will now read from these files. Mention they can edit `.red/agents/*.md` directly later, and that interactive work should land through `/ship`. Re-running this skill is only necessary if they want to switch issue trackers or restart from scratch.
