---
name: setup-red-skills
description: Sets up an `## Agent skills` block in AGENTS.md/CLAUDE.md and `.red/agents/` so the engineering skills know this repo's GitHub Issues setup, triage label vocabulary, and domain doc layout. Run before first use of `to-issues`, `to-prd`, `triage`, `diagnose`, `tdd`, `improve-codebase-architecture`, or `zoom-out` — or if those skills appear to be missing context about the issue tracker, triage labels, or domain docs.
disable-model-invocation: true
---

# Setup RedSkills

Scaffold the per-repo configuration that the engineering skills assume:

- **Issue tracker** — GitHub Issues (the only supported option, reddb.io policy)
- **Triage labels** — the strings used for the five canonical triage roles
- **Domain docs** — where `.red/CONTEXT.md` and ADRs live, and the consumer rules for reading them
- **Workflows** — GitHub Actions shipped by RedSkills (all prefixed `red-`), e.g. auto-label fresh issues with `needs-triage` so nothing slips past `/triage` and `/afk`
- **Token efficiency** — strongly recommend installing [RTK](https://github.com/rtk-ai/rtk) to cut 60–90% of dev-operation tokens via a transparent CLI proxy

This is a prompt-driven skill, not a deterministic script. Explore, present what you found, confirm with the user, then write.

## Process

### 1. Explore

Look at the current repo to understand its starting state. Read whatever exists; don't assume:

- `git remote -v` and `.git/config` — is this a GitHub repo? Which one?
- `AGENTS.md` and `CLAUDE.md` at the repo root — does either exist? Is there already an `## Agent skills` section in either?
- `.red/CONTEXT.md` and `.red/CONTEXT-MAP.md` at the repo root
- `.red/adr/` and any `src/*/.red/adr/` directories
- `.red/agents/` — does this skill's prior output already exist?

### 2. Present findings and ask

Summarise what's present and what's missing. Then walk the user through the three decisions **one at a time** — present a section, get the user's answer, then move to the next. Don't dump all three at once.

Assume the user does not know what these terms mean. Each section starts with a short explainer (what it is, why these skills need it, what changes if they pick differently). Then show the choices and the default.

**Section A — Issue tracker.**

> Explainer: In every reddb.io repo, issues and PRDs **always** live on GitHub Issues. Skills like `to-issues`, `triage`, `to-prd`, and `qa` call `gh issue create` / `gh issue edit` directly. There is no local fallback and no support for other trackers — this is a project-wide policy.

Confirm that `git remote` points to a GitHub repo, then proceed with the `issue-tracker-github.md` seed. If the repo has no GitHub remote, stop and ask the user to configure one before continuing.

**Section B — Triage label vocabulary.**

> Explainer: When the `triage` skill processes an incoming issue, it moves it through a state machine — needs evaluation, waiting on reporter, ready for an AFK agent to pick up, ready for a human, or won't fix. To do that, it needs to apply labels (or the equivalent in your issue tracker) that match strings *you've actually configured*. If your repo already uses different label names (e.g. `bug:triage` instead of `needs-triage`), map them here so the skill applies the right ones instead of creating duplicates.

The five canonical roles:

- `needs-triage` — maintainer needs to evaluate
- `needs-info` — waiting on reporter
- `ready-for-agent` — fully specified, AFK-ready (an agent can pick it up with no human context)
- `ready-for-human` — needs human implementation
- `wontfix` — will not be actioned

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

Future RedSkills workflows will land in this same step. Filename prefix `red-` is mandatory.

**Section E — Token efficiency (strongly recommended).**

> Explainer: A huge fraction of an agent's token budget gets burned on noisy CLI output — `git status` on a dirty branch, `pnpm install` with hundreds of progress lines, `gh pr list` with verbose JSON, `ls` on a `node_modules` you forgot to ignore. [RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk) is a transparent CLI proxy that rewrites those commands at the hook layer to return only what the agent actually needs. Typical savings: **60–90%** on routine dev operations, with no changes to how skills are written — the rewrite is invisible to Claude/Codex.

Strong recommendation: install before running `/afk` for any non-trivial backlog. A long `/afk` run on a busy repo can blow through a session's quota on `pnpm`/`git`/`gh` chatter alone. RTK pays for itself in the first hour.

Walk the user through the install:

```bash
# install
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/main/install.sh | sh

# verify (should print a version, NOT "command not found")
rtk --version

# baseline analytics — run after a day of usage to see savings
rtk gain
rtk gain --history
```

Two things to verify after install:

1. **No name collision.** Another tool called `rtk` (Rust Type Kit, `reachingforthejack/rtk`) sometimes lands first on `PATH`. If `rtk gain` says "command not found" or prints unrelated output, fix `PATH` so `rtk-ai/rtk` wins.
2. **Hook is active.** The Claude Code hook auto-rewrites commands like `git status` into `rtk git status`. Confirm by running `git status` once and checking `rtk gain --history` shows the call.

`rtk discover` scans recent transcripts for missed savings opportunities — useful periodically to spot commands the hook should be rewriting but isn't yet.

**Section F — `/afk` statusline (optional).**

> Explainer: When `/afk` is draining the queue, the Claude Code statusline can surface live worker count, queue depth, and aggregated diffstat at a glance — so the user doesn't need to run `/dev:afk monitor` in a side terminal. The plugin ships a small `statusline.sh` script that reads each worker's `.red/tmp/work-*/afk.state.json`, filters by `kill -0` liveness, sums diffstats locally, and caches GitHub-derived counts for 60 s to stay under the ~100 ms refresh budget.

Decide whether to wire it up for this project:

- **Skip when** the per-project plugin config (`.red/config.yaml`) sets `afk.statusline: false`. Detect with `grep -qE '^[[:space:]]*statusline:[[:space:]]*false[[:space:]]*$'` on the `afk:` block (or use `yq` if available). When skipped, log a one-line notice (`afk.statusline: false in .red/config.yaml — skipping statusline wiring`) and move on.
- **Skip when** a `statusLine` entry is already present in `.claude/settings.json`. Do **not** overwrite — log a one-line notice (`statusLine already configured in .claude/settings.json — leaving as-is`) so the user can decide. Idempotency rule: re-running `/dev:setup-red-skills` must never clobber a hand-edited statusline.
- **Otherwise** write the entry into `.claude/settings.json` (create the file if missing, merge with existing keys via `jq` if present):

  ```json
  {
    "statusLine": {
      "type": "command",
      "command": "bash ${CLAUDE_PLUGIN_ROOT}/skills/engineering/afk/scripts/statusline.sh",
      "refreshInterval": 5
    }
  }
  ```

  `${CLAUDE_PLUGIN_ROOT}` is resolved by Claude Code at refresh time to the plugin install dir, so the path stays valid wherever the plugin is mounted.

The script is no-op outside `/afk` sessions (it prints nothing when no live workers exist), so leaving the statusline wired up in non-AFK projects is harmless.

### 3. Confirm and edit

Show the user a draft of:

- The `## Agent skills` block to add to whichever of `CLAUDE.md` / `AGENTS.md` is being edited (see step 4 for selection rules)
- The contents of `.red/agents/issue-tracker.md`, `.red/agents/triage-labels.md`, `.red/agents/domain.md`

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

If the user accepted Section D, copy each `workflows/red-*.yml` template from this skill folder into `.github/workflows/` of the consumer repo. Don't overwrite existing files with the same name — diff and ask first. Then ensure the `needs-triage` label exists via `gh label create` if missing.

If the user accepted Section F, wire the statusline:

1. Check the opt-out: if `.red/config.yaml` exists and contains an `afk:` block with `statusline: false`, log `afk.statusline: false in .red/config.yaml — skipping statusline wiring` and skip the rest of this step.
2. Check for an existing `statusLine` key in `.claude/settings.json`. If one is present, log `statusLine already configured in .claude/settings.json — leaving as-is` and skip the rest of this step.
3. Otherwise, ensure `.claude/` exists and write/merge the `statusLine` block above into `.claude/settings.json`. Use `jq` for the merge when the file already has unrelated keys; create a fresh file containing only `statusLine` when missing.

### 5. Sweep existing issues

If the repo already has open issues, the new label vocabulary won't apply itself. Help the user backfill so `/triage` and `/afk` see a coherent state.

Run `gh issue list --state open --limit 200 --json number,title,labels` and group:

- **Unlabelled / missing triage role** — candidates for `needs-triage`
- **Labelled with legacy names** — map to the canonical vocabulary from Section B
- **Already correct** — skip

Skip the sweep entirely if `gh issue list` returns 0 open issues.

Present the grouping to the user as a compact table (number, title, current labels, proposed labels) and ask for batch approval. Don't apply per-issue — one confirmation, then loop `gh issue edit <n> --add-label ... --remove-label ...`. If the list is large (>30), offer to do only the first N and stop.

Never close, reassign, or edit issue bodies in this step — labels only.

### 6. Done

Tell the user the setup is complete and which engineering skills will now read from these files. Mention they can edit `.red/agents/*.md` directly later — re-running this skill is only necessary if they want to switch issue trackers or restart from scratch.
