# RedSkills

> **Issues in. Merged PRs out.**
> Reddb.io's open-source slash-command library for Claude Code, Codex, and friends. Ship while you sleep.

A reddb.io adaptation of [`mattpocock/skills`](https://github.com/mattpocock/skills) — same DNA, sharper edges, an autonomous loop layered on top. Massive thanks to [@mattpocock](https://github.com/mattpocock); the original lives at [aihero.dev](https://www.aihero.dev/s/skills-newsletter). We pin upstream via `.upstream` and a daily workflow (`red-upstream-watch.yml`) opens an issue when it advances, so we cherry-pick what's worth taking.

```
              ┌──────────────────────────────────────────┐
              │      idea  ──▶  PRD  ──▶  issues  ──▶  ⚡ /afk  ──▶  merged
              └──────────────────────────────────────────┘
                  /start    /to-prd     /to-issues
                                        /triage
```

---

## ⚡ /afk — autonomous issue execution

```
$ /afk
[afk] 12 issue(s) queued (filter=all, runner=claude, cap=∞)
[afk] ▶ #142 wire OAuth callback
[afk] feedback: test:✓ typecheck:✓ lint:✓ build:✓
[afk] ✓ #142 done in 14m 12s — merge b3f2a91 — 1/12 (8%) — next: #143
[afk] ▶ #143 normalise error envelopes
[afk] feedback: test:✓ typecheck:✓ lint:✓ build:✓
[afk] ✓ #143 done in 9m 04s — merge 8e1d70c — 2/12 (17%) — next: #144
…
[afk] /afk done.
[afk] runner    : codex (7 issues), claude (5 issues)
[afk] duration  : 02:43:11
[afk] processed : 12 closed, 0 blocked, 0 failed
```

Point it at your `ready-for-agent` backlog and walk away. For each issue, `/afk`:

| Step | What happens | Why it matters |
|------|--------------|----------------|
| **Claim** | `ready-for-agent` → `running` (atomic) | Two parallel `/afk` runs never race on the same issue |
| **Isolate** | Spawns worktree in `../.workspaces/{repo}-{N}/` | Primary checkout stays clean on `main`, always |
| **Brief** | Hands the issue's AGENT-BRIEF to Claude or Codex | The inner agent works from a contract, not the raw issue body |
| **Implement** | Inner agent codes via TDD inside the worktree | Failing test first, then code, then green |
| **Heartbeat** | Posts `:one:` → `:four:` on GitHub every 10 min | The issue is never silent during long runs |
| **Verify** | `pnpm test && typecheck && lint && build` | Three retries before flagging blocker |
| **Merge** | `git merge --no-ff` back into `main`, push over SSH | Auto-snapshot if primary is dirty; never `stash`/`reset`/`force` |
| **Close** | Validation comment, `gh issue close`, drop worktree | Per-issue summary; clean filesystem afterwards |
| **Tick** | Updates `.red/tmp/afk-state.json`, picks next | Live dashboard sees the transition instantly |
| **Survive** | Hits a rate limit? Swaps runner mid-issue. Both out? Releases claim, exits 75 | You resume tomorrow, no lost work |

### Invocation modes

```bash
/afk                            # drain everything ready-for-agent
/afk --prd 42                   # drain just the children of PRD #42
/afk --issues 356,359,362       # explicit list, in argument order
/afk --runner codex             # pin a backend (default: alternates each issue)
/afk -n 5                       # cap at five issues
/afk --once                     # supervised single iteration (debug mode)
/afk monitor                    # readonly live status board, second terminal
```

### Live monitor

`/afk` writes atomic state to `.red/tmp/afk-state.json`. Open a second terminal:

```
┌─ /afk monitor ─────────────────────────────────────────────┐
│ runner: codex          elapsed: 00:14:23   eta: ~01:20:00 │
│ done: 3 / 12 (25%)     blocked: 0          failed: 0      │
│                                                            │
│ ▶ #142 wire OAuth callback                                 │
│   worktree: ../.workspaces/red-skills-142                  │
│   stage: impl              heartbeat: :two:                │
│   last: writing tests for callback handler                 │
│                                                            │
│ queue: #143 #144 #145 #146 ...                             │
└────────────────────────────────────────────────────────────┘
```

Designed for terminals you leave open while you do something else. Or sleep.

### Safe by construction, not by hope

`/afk` enforces a strict allowlist on git: **no `reset`, no `rebase`, no `clean`, no `stash`, no `--force`, no HTTPS remotes**. Dirty primary checkouts get auto-snapshotted before merge. Merge conflicts that can't be auto-resolved release the worktree and flag the issue `ready-for-human` with the diff attached. SIGINT releases the claim and re-applies `ready-for-agent`, so a Ctrl-C never leaves an issue stranded.

→ [`afk/SAFETY.md`](./skills/engineering/afk/SAFETY.md) is binding for the orchestrator *and* the inner agent.

---

## 🔁 The pipeline that feeds it

`/afk` is the last mile. The skills compose into the full loop:

```
  vague idea
       │
       │   /start                  Grilling session: challenge the plan
       ▼                            against the existing domain model;
   refined plan                     update .red/CONTEXT.md and ADRs inline.
       │
       │   /to-prd                 Crystallise the plan into a PRD;
       ▼                            publish it as a GitHub issue.
   published PRD
       │
       │   /to-issues <PRD>        Break the PRD into vertical-slice issues,
       ▼                            each independently grabbable. Quiz the
   children issues                  user on granularity, HITL vs AFK.
       │
       │   /triage                 Per child: post AGENT-BRIEF as a comment,
       ▼                            move to ready-for-agent.
   ready-for-agent
       │
       │   /afk --prd <N>          Drain. Inner agent implements, tests pass,
       ▼                            merged, closed. Next.
   shipped
```

**Enter at any step.**
- Spec already written? Jump to `/to-issues`.
- Issues already triaged? Jump straight to `/afk`.
- Single feature, not a whole PRD? `/start` → `/to-issues` → `/afk` works fine.
- Bug report came in? `/triage` → (AGENT-BRIEF) → `/afk --issues N`.

The full issue lifecycle (`needs-triage` → `ready-for-agent` → `running` → `closed`, with `ready-for-human` and `needs-info` as branches) — including the ASCII state machine, the heartbeat protocol, and every label transition — lives in [`setup-red-skills/triage-labels.md`](./skills/engineering/setup-red-skills/triage-labels.md).

### Nothing leaks

`/setup-red-skills` installs `red-issues-needs-triage.yml`, a GitHub Action that auto-applies `needs-triage` to every fresh issue with no labels. `/afk`'s startup straggler check warns you when unlabelled, `needs-triage`, or `needs-info` issues pile up. Belt **and** braces — the pipeline is hard to leak.

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

- **[`/wiki-init`](./skills/knowledge/wiki-init/SKILL.md)** — one-time bootstrap. Three questions (domain, source types, solo vs team) and you have a schema, layout, and `## Agent skills` registration.
- **[`/wiki`](./skills/knowledge/wiki/SKILL.md)** routes by verb:

| Verb | What it does |
|------|--------------|
| `ingest <url\|path>` | Fetches the source, writes a source page, updates entity/concept pages, surfaces contradictions |
| `query <question>` | Searches index + pages, synthesises (prose, table, Mermaid), optionally files the answer back as a `synthesis` page |
| `lint` | Health check: contradictions, stale pages, orphans, stubs, missing concepts, open gaps |

Pages are typed (`entity`, `concept`, `source`, `synthesis`) with YAML frontmatter, standard markdown links (no Obsidian wikilinks — GitHub-portable), and an append-only `log.md` so every operation is auditable.

→ Walkthroughs: [research wiki](./skills/knowledge/wiki-init/examples/research.md) · [book-reading wiki](./skills/knowledge/wiki-init/examples/book-reading.md)

---

## Install

### 1. Quickstart (30 seconds)

```bash
npx skills@latest add reddb-io/red-skills
```

[skills.sh](https://skills.sh/reddb-io/red-skills) walks you through which skills to install and which coding agents to install them on. It writes the right files to the right places and you're ready to go. Same installer Matt uses for his upstream repo — credit to [@mattpocock](https://github.com/mattpocock).

After it finishes, jump to [step 3](#3-bootstrap-a-repo).

### 2. Manual install (alternative)

Prefer the source-of-truth checkout? Clone and run our `link-skills.sh`:

```bash
git clone git@github.com:reddb-io/red-skills.git ~/code/red-skills
cd ~/code/red-skills
./scripts/link-skills.sh
```

`link-skills.sh` symlinks every `SKILL.md` directory into `~/.claude/skills/`. Re-run any time the repo updates — it overwrites symlinks in place.

```bash
$ ./scripts/link-skills.sh
linked afk -> ~/code/red-skills/skills/engineering/afk
linked diagnose -> ~/code/red-skills/skills/engineering/diagnose
linked wiki -> ~/code/red-skills/skills/knowledge/wiki
…
```

Verify:

```bash
ls ~/.claude/skills/afk          # should be a symlink into the clone
cat ~/.claude/skills/afk/SKILL.md | head -5
```

Update later:

```bash
cd ~/code/red-skills && git pull && ./scripts/link-skills.sh
```

Symlinks point at the working tree, so a `git pull` updates every agent that consumes the skills.

### Pick your agent

| Agent | Invocation | Notes |
|-------|------------|-------|
| **Claude Code** | `/afk`, `/wiki`, `/triage`, … | Native slash commands. The plugin loader auto-discovers everything under `~/.claude/skills/`. |
| **Codex CLI** | `$afk`, `$wiki`, `$triage`, … | The `$` is a convention: when the agent sees `$<name>`, it finds `~/.claude/skills/<name>/SKILL.md` on disk and follows the instructions (typically `bash <skill>/scripts/<n>.sh`). Add the snippet below to `~/.codex/AGENTS.md` once, and every skill becomes invokable. |
| **Gemini CLI / others** | `$afk`, etc. | Same `$<name>` convention. Works with any agent that can read files under `~/.claude/skills/` and run bash. |

Teach Codex (or any non-Claude-Code agent) the convention by appending to `~/.codex/AGENTS.md` (or the equivalent global agent doc):

```markdown
## RedSkills

When the user types `$<name>` (e.g. `$afk`, `$wiki`, `$triage`), look up
`~/.claude/skills/<name>/SKILL.md` and follow it — usually that means running
`bash ~/.claude/skills/<name>/scripts/<entrypoint>.sh` with the documented flags.
Each SKILL.md is self-documenting; read it before invoking.
```

---

### 3. Bootstrap a repo

Run this once per target repo (from inside the repo):

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

### ⛽ Before a long /afk run — install RTK

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

## Philosophy

Small, sharp skills. They work with any model. Each one targets a specific failure mode of code agents:

| Failure mode | Use |
|--------------|-----|
| Agent didn't do what I want | [`/reflect`](./skills/productivity/reflect/SKILL.md), [`/start`](./skills/engineering/start/SKILL.md) |
| Agent is verbose, no shared vocabulary | `.red/CONTEXT.md` + [`/start`](./skills/engineering/start/SKILL.md) |
| Code doesn't work | [`/tdd`](./skills/engineering/tdd/SKILL.md), [`/diagnose`](./skills/engineering/diagnose/SKILL.md) |
| Codebase turned into a mud ball | [`/to-prd`](./skills/engineering/to-prd/SKILL.md), [`/zoom-out`](./skills/engineering/zoom-out/SKILL.md), [`/improve-codebase-architecture`](./skills/engineering/improve-codebase-architecture/SKILL.md) |
| I want it to run while I sleep | [`/afk`](./skills/engineering/afk/SKILL.md) |

Composable. Boring on purpose where boring is enough. Sharp where it matters.

---

## Reference

<details>
<summary><strong>Engineering — daily code work</strong></summary>

| Skill | What it does |
|-------|--------------|
| **[afk](./skills/engineering/afk/SKILL.md)** | Drains `ready-for-agent` issues in isolated worktrees. Claude/Codex alternating. Live heartbeat + monitor + completion %. |
| **[diagnose](./skills/engineering/diagnose/SKILL.md)** | Disciplined diagnosis: reproduce → minimise → hypothesise → instrument → fix → regression-test. |
| **[start](./skills/engineering/start/SKILL.md)** | Grilling session that challenges your plan against the domain model; updates `.red/CONTEXT.md` and ADRs inline. |
| **[triage](./skills/engineering/triage/SKILL.md)** | Moves issues through the triage state machine; writes the AGENT-BRIEF that `/afk` will consume. |
| **[improve-codebase-architecture](./skills/engineering/improve-codebase-architecture/SKILL.md)** | Finds deepening opportunities in the codebase, informed by `.red/CONTEXT.md` and `.red/adr/`. |
| **[tdd](./skills/engineering/tdd/SKILL.md)** | Red-green-refactor loop; one vertical slice at a time. |
| **[to-issues](./skills/engineering/to-issues/SKILL.md)** | Breaks a plan, spec, or PRD into independently-grabbable issues via vertical slices. |
| **[to-prd](./skills/engineering/to-prd/SKILL.md)** | Turns the current conversation into a PRD; publishes as a GitHub issue. |
| **[zoom-out](./skills/engineering/zoom-out/SKILL.md)** | Broader / systemic view of unfamiliar code. |
| **[prototype](./skills/engineering/prototype/SKILL.md)** | Throwaway prototype — terminal app for state/logic, or UI variations toggleable from one route. |
| **[setup-red-skills](./skills/engineering/setup-red-skills/SKILL.md)** | Per-repo config: issue tracker, triage label vocab, domain doc layout, RedSkills workflows, RTK. |

</details>

<details>
<summary><strong>Knowledge — incremental wiki</strong></summary>

| Skill | What it does |
|-------|--------------|
| **[wiki-init](./skills/knowledge/wiki-init/SKILL.md)** | Bootstrap `.red/wiki/`, write the schema, gitignore artefacts, register under `## Agent skills`. |
| **[wiki](./skills/knowledge/wiki/SKILL.md)** | `ingest` / `query` / `lint` — operate on the wiki. |

</details>

<details>
<summary><strong>Productivity — workflow</strong></summary>

| Skill | What it does |
|-------|--------------|
| **[caveman](./skills/productivity/caveman/SKILL.md)** | Ultra-compressed mode. ~75% fewer tokens, same technical accuracy. |
| **[reflect](./skills/productivity/reflect/SKILL.md)** | Interviews you until every branch of the decision tree is resolved. |
| **[handoff](./skills/productivity/handoff/SKILL.md)** | Compacts the current conversation into a handoff doc for the next agent. |
| **[write-a-skill](./skills/productivity/write-a-skill/SKILL.md)** | Scaffolds new skills with proper structure and progressive disclosure. |

</details>

<details>
<summary><strong>Misc — niche utilities</strong></summary>

| Skill | What it does |
|-------|--------------|
| **[git-guardrails-claude-code](./skills/misc/git-guardrails-claude-code/SKILL.md)** | Claude Code hooks that block destructive git commands. |
| **[migrate-to-shoehorn](./skills/misc/migrate-to-shoehorn/SKILL.md)** | Migrates test files from `as` type assertions to `@total-typescript/shoehorn`. |
| **[scaffold-exercises](./skills/misc/scaffold-exercises/SKILL.md)** | Creates exercise scaffolds with sections, problems, solutions. |
| **[setup-pre-commit](./skills/misc/setup-pre-commit/SKILL.md)** | Configures Husky pre-commit with lint-staged, Prettier, type-check, tests. |

</details>

---

## House conventions

- 🇬🇧 **All repo content is English.** No exceptions. User chat may stay Portuguese.
- 🏷 **Labels are kebab-case or `prefix:value`.** `needs-triage`, `ready-for-agent`, `running`, `priority:high`, `slice:afk`, `prd:42`. No uppercase, no spaces.
- 🤖 **Workflows shipped by RedSkills start with `red-`.** `red-issues-needs-triage.yml`, `red-upstream-watch.yml`.
- 🐙 **Issues and PRDs live on GitHub.** No local-markdown tracker, no GitLab/Jira/Linear fallback.
- 📁 **Artefacts live under `.red/`.** Context glossary, ADRs, agent docs, the wiki, the `/afk` state file. Keeps consumer repos clean.
- 🔒 **SSH for git, every time.** No HTTPS remotes. `/afk` refuses to start otherwise.

---

## License

MIT, inherited from [`mattpocock/skills`](https://github.com/mattpocock/skills). See [LICENSE](./LICENSE).
