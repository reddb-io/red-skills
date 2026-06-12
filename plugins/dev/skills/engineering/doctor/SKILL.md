---
name: doctor
description: Adoption/process doctor — report how fully a repo has adopted the RedSkills engineering stack (triage label vocabulary, AGENTS≡CLAUDE parity, Development-workflow adoption, statusline form, MCP wiring, blocked-label hygiene, version coherence, installed `red-skills-*` workflow adoption). Read-only by default; `--fix` applies the canonical fix for every finding, gated per hard-to-reverse change. The recurring counterpart to the one-time `/setup-red-skills`. Use when asked "is our process round / is this repo set up right", "red doctor", "check adoption", "doctor --fix", before a large `/afk` drain, or to audit `reddb`/`red-ui`/`red-skills`-style repos against the canonical conventions.
argument-hint: "[--repo <path|owner/name>] [--fix]"
---

# Doctor (adoption / process)

The recurring counterpart to the one-time `/setup-red-skills` — the same split the
`memory` plugin has between `context-status` (read-only) and its setup. It reports
how fully a repo adopted the RedSkills stack and **names the fix-home for each gap**.
**Default is read-only.** With `--fix` it becomes the reconciler that actually heals
every finding, applying each gap's canonical fix and gating every hard-to-reverse
change behind explicit per-item confirmation.

<what-to-do>

**Always run Pass 1 (Diagnose, read-only) and print the scorecard. Then, only when invoked with `--fix`, run Pass 2 (Fix) — apply the canonical fix for every finding, batching the safe ones and confirming each hard-to-reverse one individually.**

### Hard rules

- ✅ **Default (no `--fix`) is read-only**: no `gh label create/edit/delete`, no file writes, no `gh issue edit`, no MCP/hook/statusline install. Pass 1 is a pure diagnostic.
- ✅ **`--fix` is the only mutating path**, and even then: the safe fixes apply in a batch (with a one-line receipt each); every **hard-to-reverse** fix — label rename/retire, config-key migration, `blocked:*` rotation, MCP rewrite — is **confirmed individually before it runs**.
- ❌ Never hand-edit what a single-writer tool owns: a version mismatch is fixed by **running** the version script (ADR 0040), never by editing a manifest. `--fix` invokes the tool; it does not patch around it.
- ✅ Compose existing surfaces — `memory context-status`, `/wiki lint`, the development-workflow injector, `gh` — instead of re-implementing them.
- ✅ Resolve the canonical vocabulary from the **target repo's** `.red/agents/triage-labels.md` (each repo may map roles to its own strings — respect that mapping, don't impose red-skills' defaults).

### Pass 1 — Diagnose (always; read-only)

Run the checks against the target repo (cwd by default; `--repo <path|owner/name>` for another, or sweep a list). Read only.

1. **Local context stack** — invoke `memory context-status` (or its CLI) and fold its result in. Do not duplicate its checks (CLAUDE/AGENTS, `.red/CONTEXT(-MAP)`, `.red/adr/*`, memory, wiki).
2. **Label conformance** — `gh label list` vs the canonical families in `triage-labels.md`. Classify every label per the *Label classes* table in `<supporting-info>`. Report `❌ synonym` / `⚠️ legacy` / `⚠️ naming` with the suggested rename; in this pass never apply it.
3. **`blocked:*` hygiene** — list open issues carrying `ready-for-agent` **or** `running` **together with** any `blocked:*` label (stale reason not rotated on re-queue). Count them.
4. **AGENTS ≡ CLAUDE Agent-skills parity** — both files exist **and** both carry the `## Agent skills` block. Report `C/A` (e.g. `1/0` = block in CLAUDE only). Missing files, missing blocks, or unequal treatment are findings tagged `→ /setup-red-skills`.
5. **AGENTS ≡ CLAUDE Development-workflow parity** — both files exist **and** both carry the `## Development workflow` block with the same treatment. Report `C/A` for presence (e.g. `1/0` = block in CLAUDE only), and report any missing file, missing block, or out-of-parity block as a finding tagged `→ /setup-red-skills`. During this read-only pass: do not run `inject-development-workflow`, do not create files, do not edit either agent rules file — that is the `--fix` lane's job.
6. **Primary-branch guard flag** — read `.red/config.yaml` and report whether `dev.lock.primary-branch` is set (the nested `dev:` → `lock:` → `primary-branch` key, or its `plugins.dev.lock.primary-branch` form). Treat an absent config file, absent `dev` block, absent key, or key set to anything other than `true` as "unset" and recommend enabling it via `→ /setup-red-skills`; report `true` as adopted. Also flag a **stale/renamed key** (a legacy flat `lock-primary-branch`) as a migration finding. During this read-only pass: never write `.red/config.yaml`.
7. **Statusline drift** — the installed `.claude/settings.json` `statusLine` command resolves the **cached bundle** (`~/.cache/red-skills/bundles/dev-*.bundle.min.mjs`), not the OLD launcher form (`…/plugins/cache/red-skills/dev/*/…/afk.mjs`) which blanks on every plugin update.
8. **MCP wiring** — does the repo wire the expected MCPs? The `dev` plugin should expose `code-nav`; the `memory` plugin should expose **`red-memory` + `red-ui` as consumers** (fetched from the red-memory / red-ui releases per ADR 0041) — **flag a single standalone-local `memory` server** (running an in-repo `bootstrap.mjs`/build) as the pre-migration state. Also check whether the repo wires `code-nav`/`red-memory` for its **own** dev (root `.mcp.json` or agent-doc reference).
9. **Version coherence** — every plugin manifest pair is on the same version: for each `plugins/*/`, `.claude-plugin/plugin.json` `version` **==** `.codex-plugin/plugin.json` `version`. A mismatch is what `validate-install-metadata.sh` rejects and what fails `red-release` (e.g. a stale manifest landed manually). Fix-home = `→ release` (the single-writer version script, ADR 0040).
10. **Installed-workflow (`red-skills-*`) adoption** — list `.github/workflows/*.yml` and audit the **RedSkills-installed** workflows *already present* (do **not** recommend installing a lane the repo didn't opt into — that stays a `/setup-red-skills` decision, and our own `red-*` CI is never imposed). Two findings, both tagged `→ /setup-red-skills`:
    - **Naming drift** — a copied RedSkills workflow that carries the wrong prefix: an installed copy must be `red-skills-<name>.yml`, so a file still named `red-<name>.yml` or `reusable-<name>.yml` sitting in a **non-red-skills** repo's `.github/workflows/` (e.g. an installed needs-triage labeler or AFK caller) is drift; report the rename to `red-skills-<name>.yml`. (The `reusable-afk-attempt.yml` reusable referenced by `uses:` is exempt — it is *called*, never copied into the adopter.)
    - **AFK lane auth gap** — if `red-skills-afk-attempt.yml` (or a drifted copy under another prefix) is installed, best-effort check that an OpenCode auth secret **name** is present via `gh secret list --repo <repo>` (names only — never read or print a value). If none of `MINIMAX_API_KEY`/`OPENAI_API_KEY`/`OPENROUTER_API_KEY` is listed, flag the lane as installed-but-unauthed (the public-repo org-secret gotcha — on a public repo an org secret resolves empty unless its Repository access includes the repo). Skip silently if `gh secret list` 403s (no admin scope); report `unknown`, not a failure.

**Scorecard** (always printed): one row per check (✅/⚠️/❌ + one-line evidence) + a readiness score (count of green checks, like `context-status`) + a prioritized recommendation list, **every recommendation carrying a fix-home tag** from the *Fix-home* table. End with the single highest-impact next step.

### Pass 2 — Fix (only with `--fix`; gated apply)

For **every** non-green finding from Pass 1, apply its canonical fix from the *Apply* table in `<supporting-info>`. There is no finding the doctor reports but cannot heal: each row maps to a concrete action or a delegation to the single-writer tool that owns it.

The loop:

1. **Group the findings** into **safe** (idempotent, low-blast-radius) and **hard-to-reverse** (per the *Apply* table's gate column).
2. **Apply the safe batch** — run each safe fix, print a one-line receipt per action (`✅ created label needs-triage`, `✅ injected ## Development workflow into AGENTS.md`, …). Re-running is a no-op.
3. **Confirm each hard-to-reverse fix individually** — show the exact mutation (the `gh label rename old new` that re-tags N issues, the config-key migration, the `blocked:*` removal on issue #N, the `.mcp.json` edit) and apply only on an explicit yes. A no leaves that finding open and recorded.
4. **Delegate** what a single-writer tool owns — a version mismatch runs the version/release tool (never a manual manifest edit); context-stack gaps run the `memory`/context skills. `--fix` triggers the tool, then re-checks.
5. **Re-diagnose** the touched checks and print a fix receipt: what was applied, what was confirmed-then-applied, what was skipped (declined), and the new readiness score.

</what-to-do>

<supporting-info>

### Label classes (check 2)

| Class | Meaning | Action |
|---|---|---|
| ❌ non-canonical synonym | duplicates a canonical role under a different name (`needs-human-decision` ↔ `ready-for-human`) | rename to the canonical role |
| ⚠️ legacy / superseded | older form replaced by a newer one (bare `blocked` vs typed `blocked:<reason>`) | migrate + retire |
| ⚠️ naming violation | not kebab-case nor `prefix:value` (uppercase / CamelCase / snake_case / spaces) | normalize |
| ✅ accepted aux | outside the triage families but legitimate (language labels, repo-custom like `drill`, `release-blocker`) | none |
| ✅ GitHub default | `bug`, `enhancement`, `documentation`, `duplicate`, `good first issue`, `help wanted`, `invalid`, `question`, `wontfix` | none |

Canonical families live in the target repo's `.red/agents/triage-labels.md`: state (`needs-triage`, `needs-info`, `ready-for-agent`, `running`, `ready-for-human`, `wontfix`), dependency (`blocked:dependency`, `req:N`), typed blocked-reasons (`blocked:quota|runner-transient|merge-conflict|spec|validation|crashed|policy|stalled|infra`), type (`type:prd`, `type:bug`, `needs-slicing`), priority (`priority:high|low|urgent`), relationship (`prd:N`), operational (`runner-error`).

### Fix-home (every Pass-1 recommendation carries one)

| Fix-home | Findings it owns |
|---|---|
| `→ /setup-red-skills` | AGENTS≡CLAUDE `## Agent skills` parity, AGENTS≡CLAUDE `## Development workflow` parity, `dev.lock.primary-branch` adoption, statusline drift, MCP wiring, label provisioning, installed-workflow (`red-skills-*`) naming drift + AFK-lane auth gap. |
| `→ AFK runtime` | `blocked:*` accumulation (labels must be rotated/cleared on re-queue, plus the re-claim cap) — a bundle change, not a config edit. |
| `→ manual / maintainer` | label renames (`gh label edit`), retiring legacy labels — the operator decides. |
| `→ release` | cross-manifest version mismatch — owned by the single-writer version script + `validate-install-metadata.sh` gate (ADR 0040); never hand-edit one manifest. |

### Apply (what `--fix` runs per finding, and its gate)

| Finding | `--fix` action | Gate |
|---|---|---|
| Missing canonical label | `gh label create <name> --color <c> --description "<d>"` | **safe** (batch) |
| AGENTS≡CLAUDE Agent-skills / Development-workflow parity | run the development-workflow injector (`inject-development-workflow --root <repo>`) — upserts both blocks in place | **safe** (batch; idempotent) |
| `dev.lock.primary-branch` unset | same injector (it sets the nested flag) | **safe** (batch) |
| Statusline drift | rewrite the `.claude/settings.json` `statusLine` to the cached-bundle form (jq merge, preserve other keys) | **safe** (batch) |
| Label synonym / legacy / naming | `gh label rename <old> <new>` (or create canonical + migrate, then retire the old) | **confirm each** — re-tags every issue carrying the old label |
| Stale/renamed config key (e.g. legacy `lock-primary-branch`) | migrate to the canonical nested key + delete the orphan in `.red/config.yaml` | **confirm each** |
| `blocked:*` on a `ready-for-agent`/`running` issue | `gh issue edit <N> --remove-label blocked:<reason>` (rotate the stale reason) | **confirm each** |
| MCP wiring | add/correct the expected servers in the repo's `.mcp.json` | **confirm each** |
| Version coherence mismatch | **run** the single-writer version/release tool (ADR 0040); never patch a manifest | **delegate** |
| Installed-workflow `red-skills-*` naming drift | `git mv .github/workflows/<wrong-prefix>-<name>.yml .github/workflows/red-skills-<name>.yml` (filename only; body unchanged) | **confirm each** — renames a CI file |
| AFK-lane auth gap (`red-skills-afk-attempt.yml`, no auth secret) | **do not set the secret** — print the per-provider `gh secret set … --repo` guidance + the public-repo org-secret note; delegate to `/setup-red-skills` | **delegate** |
| Context-stack gap (check 1) | run the relevant `memory`/context skill | **delegate** |

### Scope & boundaries

- **Single repo** by default; multi-repo sweep is opt-in. With `--fix`, a sweep applies per-repo with the same gating.
- **Public-repo safe**: reads only conventions already public in the repo; **emits no secret values** (it may list secret *names* via `gh secret list` to detect the AFK-lane auth gap — names are not sensitive — and never reads or prints a value). It does **not** impose RedSkills' own `red-*` CI (release/bench/drift-guard/upstream-watch) onto an adopter repo — that stays out of scope. What it *does* audit is the **adoption coherence of `red-skills-*` workflows already installed** (correct installed-name + the AFK lane's auth secret), never installing a lane the repo didn't opt into.
- Pairs with `/review-adrs` (decision-record coherence) and `memory:doctor` (graph health) — three doctors over different axes; this one owns **process/adoption** and is the one that can both diagnose and, with `--fix`, heal.

</supporting-info>
