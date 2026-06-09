---
name: doctor
description: Read-only adoption/process doctor — report how fully a repo has adopted the RedSkills engineering stack (triage label vocabulary, AGENTS≡CLAUDE parity, Development-workflow adoption, statusline form, MCP wiring, blocked-label hygiene) and recommend fixes without applying any. The recurring counterpart to the one-time `/setup-red-skills`. Use when asked "is our process round / is this repo set up right", "red doctor", "check adoption", before a large `/afk` drain, or to audit `reddb`/`red-ui`/`red-skills`-style repos against the canonical conventions.
---

# Doctor (adoption / process)

The read-only, recurring counterpart to the mutating one-time `/setup-red-skills`
— the same split the `memory` plugin has between `context-status` (read-only) and
its setup. It reports how fully a repo adopted the RedSkills stack and **names the
fix-home for each gap**; it never applies a fix.

<what-to-do>

**Run the checks below against the target repo (cwd by default; `--repo <path|owner/name>` for another, or sweep a list). Read only. Then print the scorecard.**

### Hard rules

- ❌ Never mutate: no `gh label create/edit/delete`, no file writes, no `gh issue edit`, no MCP/hook/statusline install. This is a diagnostic.
- ❌ Never "fix while you're there." Every finding names where the fix lives — you do not perform it.
- ✅ Compose existing read-only surfaces (`memory context-status`, `/wiki lint`) instead of re-implementing them.
- ✅ Resolve the canonical vocabulary from the **target repo's** `.red/agents/triage-labels.md` (each repo may map roles to its own strings — respect that mapping, don't impose red-skills' defaults).

### The check loop

1. **Local context stack** — invoke `memory context-status` (or its CLI) and fold its result in. Do not duplicate its checks (CLAUDE/AGENTS, `.red/CONTEXT(-MAP)`, `.red/adr/*`, memory, wiki).
2. **Label conformance** — `gh label list` vs the canonical families in `triage-labels.md`. Classify every label per the *Label classes* table in `<supporting-info>`. Report `❌ synonym` / `⚠️ legacy` / `⚠️ naming` with the suggested rename; never apply it.
3. **`blocked:*` hygiene** — list open issues carrying `ready-for-agent` **or** `running` **together with** any `blocked:*` label (stale reason not rotated on re-queue). Count them.
4. **AGENTS ≡ CLAUDE Agent-skills parity** — both files exist **and** both carry the `## Agent skills` block. Report `C/A` (e.g. `1/0` = block in CLAUDE only). Missing files, missing blocks, or unequal treatment are findings tagged `→ /setup-red-skills`.
5. **AGENTS ≡ CLAUDE Development-workflow parity** — both files exist **and** both carry the `## Development workflow` block with the same treatment. Report `C/A` for presence (e.g. `1/0` = block in CLAUDE only), and report any missing file, missing block, or out-of-parity block as a finding tagged `→ /setup-red-skills`. This is read-only: do not run `inject-development-workflow`, do not create files, and do not edit either agent rules file.
6. **Primary-branch guard flag** — read `.red/config.yaml` and report whether `dev.lock-primary-branch` is set. Treat an absent config file, absent `dev` block, absent key, or key set to anything other than `true` as "unset" and recommend enabling it via `→ /setup-red-skills`; report `true` as adopted. This is read-only: never write `.red/config.yaml`.
7. **Statusline drift** — the installed `.claude/settings.json` `statusLine` command resolves the **cached bundle** (`~/.cache/red-skills/bundles/dev-*.bundle.min.mjs`), not the OLD launcher form (`…/plugins/cache/red-skills/dev/*/…/afk.mjs`) which blanks on every plugin update.
8. **MCP wiring** — does the repo wire the expected MCPs? The `dev` plugin should expose `code-nav`; the `memory` plugin should expose **`red-memory` + `red-ui` as consumers** (fetched from the red-memory / red-ui releases per ADR 0041) — **flag a single standalone-local `memory` server** (running an in-repo `bootstrap.mjs`/build) as the pre-migration state. Also check whether the repo wires `code-nav`/`red-memory` for its **own** dev (root `.mcp.json` or agent-doc reference).
9. **Version coherence** — every plugin manifest pair is on the same version: for each `plugins/*/`, `.claude-plugin/plugin.json` `version` **==** `.codex-plugin/plugin.json` `version`. A mismatch is what `validate-install-metadata.sh` rejects and what fails `red-release` (e.g. a stale manifest landed manually). Fix-home = `→ release` (the single-writer version script, ADR 0040).

### Output

A scorecard (one row per check: ✅/⚠️/❌ + one-line evidence) + a readiness score (count of green checks, like `context-status`) + a prioritized recommendation list. **Every recommendation carries a fix-home tag** from the *Fix-home* table. End with the single highest-impact next step. Do not offer to perform any of them inside this skill.

</what-to-do>

<supporting-info>

### Label classes (check 2)

| Class | Meaning | Action |
|---|---|---|
| ❌ non-canonical synonym | duplicates a canonical role under a different name (`needs-human-decision` ↔ `ready-for-human`) | recommend rename to the canonical role |
| ⚠️ legacy / superseded | older form replaced by a newer one (bare `blocked` vs typed `blocked:<reason>`) | recommend migrate + retire |
| ⚠️ naming violation | not kebab-case nor `prefix:value` (uppercase / CamelCase / snake_case / spaces) | recommend normalize |
| ✅ accepted aux | outside the triage families but legitimate (language labels, repo-custom like `drill`, `release-blocker`) | none |
| ✅ GitHub default | `bug`, `enhancement`, `documentation`, `duplicate`, `good first issue`, `help wanted`, `invalid`, `question`, `wontfix` | none |

Canonical families live in the target repo's `.red/agents/triage-labels.md`: state (`needs-triage`, `needs-info`, `ready-for-agent`, `running`, `ready-for-human`, `wontfix`), dependency (`blocked:dependency`, `req:N`), typed blocked-reasons (`blocked:quota|runner-transient|merge-conflict|spec|validation|crashed|policy|stalled|infra`), type (`type:prd`, `type:bug`, `needs-slicing`), priority (`priority:high|low|urgent`), relationship (`prd:N`), operational (`runner-error`).

### Fix-home (every recommendation must be tagged)

| Fix-home | Findings it owns |
|---|---|
| `→ /setup-red-skills` | AGENTS≡CLAUDE `## Agent skills` parity, AGENTS≡CLAUDE `## Development workflow` parity, `dev.lock-primary-branch` adoption, statusline drift, MCP wiring, label provisioning. |
| `→ AFK runtime` | `blocked:*` accumulation (labels must be rotated/cleared on re-queue, plus the re-claim cap) — a bundle change, not a config edit. |
| `→ manual / maintainer` | label renames (`gh label edit`), retiring legacy labels — the operator decides, the doctor never runs it. |
| `→ release` | cross-manifest version mismatch — owned by the single-writer version script + `validate-install-metadata.sh` gate (ADR 0040); never hand-edit one manifest. |

### Scope & boundaries

- **Single repo** by default; multi-repo sweep is opt-in.
- **Public-repo safe**: reads only conventions already public in the repo; emits no secrets and proposes no CI/CD standardization (explicitly out of scope — do not recommend forcing `red-`-prefixed workflows on a repo's own CI).
- Pairs with `/review-adrs` (decision-record coherence) and `memory:doctor` (graph health) — three read-only doctors over different axes; this one owns **process/adoption**.

</supporting-info>
