---
name: red-doctor
description: Adoption/process doctor — reports how fully a repo has adopted the RedSkills engineering stack. Read-only by default; `--fix` applies the canonical fix for every finding, gated per hard-to-reverse change. The recurring counterpart to the one-time `/red-setup`. Use when asked "red doctor", "check adoption", before a large `/afk` drain, or to verify a repo against canonical conventions.
argument-hint: "[--repo <path|owner/name>] [--fix]"
---

# Doctor (adoption / process)

**Run the adoption/process check read-only; apply every canonical fix with `--fix` — never hand-edit what a single-writer tool owns, because each gap's fix-home already exists.**

The recurring counterpart to the one-time `/red-setup` — the same split the
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
4. **AGENTS ≡ CLAUDE Agent-skills parity** — both files exist **and** both carry the `## Agent skills` block. Report `C/A` (e.g. `1/0` = block in CLAUDE only). Missing files, missing blocks, or unequal treatment are findings tagged `→ /red-setup`.
5. **AGENTS ≡ CLAUDE Development-workflow parity** — both files exist **and** both carry the `## Development workflow` block with the same treatment. Report `C/A` for presence (e.g. `1/0` = block in CLAUDE only), and report any missing file, missing block, or out-of-parity block as a finding tagged `→ /red-setup`. During this read-only pass: do not run `inject-development-workflow`, do not create files, do not edit either agent rules file — that is the `--fix` lane's job.
6. **Config namespacing + primary-branch guard** — read `.red/config.yaml`, two findings:
    - **Guard flag** — report whether the primary-branch guard resolves to `true`. The canonical key is the namespaced `plugins.dev.lock.primary-branch`; the legacy top-level `dev.lock.primary-branch` and flat `lock-primary-branch` still resolve through the ADR 0042 / PR #697 fold (the whole `plugins.dev.*` block folds onto the `dev.*` accessors, the namespaced form winning). Treat an absent config file, absent block, absent key, or any value other than `true` as "unset" → recommend `→ /red-setup`; report `true` as adopted.
    - **Namespacing conformance** (the strict structural check) — dev-plugin settings belong under `plugins.dev.*`. Flag any **legacy top-level placement** as a migration finding: a top-level `afk:` block (canonical `plugins.dev.afk.*`), a top-level `dev:` block carrying plugin settings such as `dev.lock.*` (canonical `plugins.dev.lock.*`), or the flat `lock-primary-branch`. The fold still reads these, so this is **hygiene, not breakage** — but the canonical written form is namespaced and `/red-setup` now writes it that way, so a top-level form is drift to migrate. Tag `→ /red-setup`.

    During this read-only pass: never write `.red/config.yaml`.
7. **Statusline drift** — the installed `.claude/settings.json` `statusLine` command resolves the **cached bundle** (`~/.cache/red-skills/bundles/dev-*.bundle.min.mjs`), not the OLD launcher form (`…/plugins/cache/red-skills/dev/*/…/afk.mjs`) which blanks on every plugin update.
8. **MCP wiring** — does the repo wire the expected MCPs? The `dev` plugin should expose `code-nav`; the `memory` plugin should expose **`red-memory` (the local data MCP, a local server that execs the in-repo `bootstrap.mjs`, built from `apps/memory`, RedDB-backed via `@reddb-io/sdk`) + `red-ui` (the visualizer consumer)** — this local shape is the **intended** wiring, **not** drift (ADR 0041 Amendment 1 reversed the release-fetched migration). What *is* a finding: a server still named **`memory`** that was never renamed to `red-memory`, or a `.mcp.json`/routing-guide that tries to **fetch `red-memory` from a GitHub release** (there is no such release). Also check whether the repo wires `code-nav`/`red-memory` for its **own** dev (root `.mcp.json` or agent-doc reference).
9. **Version coherence** — every plugin manifest pair is on the same version: for each `plugins/*/`, `.claude-plugin/plugin.json` `version` **==** `.codex-plugin/plugin.json` `version`. A mismatch is what `validate-install-metadata.sh` rejects and what fails `red-release` (e.g. a stale manifest landed manually). Fix-home = `→ release` (the single-writer version script, ADR 0040).
10. **Workflow naming convention** — list `.github/workflows/*.yml` and classify each by **role**, decidable from its content: has `workflow_call:` → must be `reusable-*`; `uses:` a `reusable-*` → must be `rs-*` (a caller / instantiation); otherwise → must be `red-*` (a standalone workflow). Applies both in red-skills itself and in an adopter repo. Two findings, both tagged `→ /red-setup`:
    - **Naming drift** — a file whose filename prefix doesn't match its role: a reusable caller named `red-*` (should be `rs-*`), a standalone named `rs-*`/`reusable-*` (should be `red-*`), a `workflow_call` workflow not named `reusable-*`, or a legacy `red-skills-*` (the retired caller prefix → now `rs-*`). Report the rename to the role-correct prefix. (A `reusable-*` referenced via `uses:` from another repo is exempt — it is *called*, never copied.)
    - **AFK lane auth gap** — if `rs-afk-attempt.yml` (or a drifted copy under another prefix) is installed, best-effort check that an OpenCode auth secret **name** is present via `gh secret list --repo <repo>` (names only — never read or print a value). If none of `MINIMAX_API_KEY`/`OPENAI_API_KEY`/`OPENROUTER_API_KEY` is listed, flag the lane as installed-but-unauthed (the public-repo org-secret gotcha — on a public repo an org secret resolves empty unless its Repository access includes the repo). Skip silently if `gh secret list` 403s (no admin scope); report `unknown`, not a failure.
11. **`.red/.gitignore` self-ignore** — only when `.red/` exists: check that `.red/.gitignore` is present **and** ignores `tmp/` (and `state/`), so ephemeral runtime state can't be committed even if the repo-root `.gitignore` lacks the patterns (ADR 0067; `/red-setup` writes this on creation). Report `❌` when `.red/` exists but `.red/.gitignore` is absent or missing the `tmp/` pattern (one-line evidence: which patterns are missing); `✅` when both `tmp/` and `state/` are ignored. Tag `→ /red-setup`. During this read-only pass: never write `.red/.gitignore`. Skip the check silently when `.red/` does not exist.
12. **AFK hook / backpressure static validation** — read `.red/config.yaml` (the `plugins.dev.afk.backpressure` list + the `plugins.dev.afk.hooks.<point>` entries, legacy bare `afk.*` fallback) and the `.red/hooks/<point>/` tree, and classify every backpressure command and hook script **statically — never execute one** (the trust model is "scripts in your own repo are trusted"; this check resolves, it does not run). Per command: `❌` when it references a renamed/missing `package.json` script (`pnpm run <gone>`) or a non-existent file path, or a `red-*` library/shadow target that does not resolve; `⚠️` (conservative) when it cannot be statically resolved (a bare PATH binary like `curl`/`make` — maybe valid, never a hard fail); `✅` when it resolves. **Unknown hook names** (today a hard boot error) are pre-caught here read-only and reported `❌` before the next drain parks every issue. Tag `→ /red-setup`. The classifier is `apps/dev/src/core/hook-doctor.ts` (`validateHookConfig`), driven by the canonical hook registry (`hook-registry.ts`, #834). During this read-only pass: never write config and **never execute a command**.
13. **Per-plugin runtime distribution** — audit, per plugin (`dev`, `memory`, `brain`), the **ADR 0084 control-plane contract**: a plugin the config marks on **must** have a present, readable, checksum-valid, current cached bundle. This turns the former **silent-no-op class** (`enabled: true` whose runtime never arrived) into visible, named findings. Read the nearest `.red/config.yaml` `plugins.<name>.enabled` flag, the installed version from `.claude-plugin/plugin.json`, and the cached bundle (`~/.cache/red-skills/bundles/<plugin>-<version>.bundle.min.mjs`, ADR 0034/0038). Three failure axes:
    - **Enabled vs runtime present** — `plugins.<name>.enabled: true` but **no cached bundle** → `❌ runtime-missing`; only the **inert marker a failed fetch left behind** → `❌ inert-marker`. The plugin is "on" but does nothing.
    - **Version drift** — the cached bundle is **behind the latest compatible Release**, stale beyond the self-update expectation (#1033) → `⚠️ version-drift`. It still runs, just not the current runtime. **Suppressed when the latest release can't be resolved** (offline / rate-limited) — never a false positive when we could not ask.
    - **Cache integrity** — the cached bundle is **unreadable or its bytes fail the published sha256** → `❌ cache-corrupt` (outranks drift: a bundle whose bytes are wrong has no version to trust).

    A **disabled** plugin is **inert by design** (the ADR 0067 gate) → never a finding, whatever its cache. A **healthy three-plugin setup produces zero findings**. Every finding's remediation is the **launcher fetch** (`red-fetch.mjs <plugin> <version>`), never a hand edit of a fetched asset. Tag `→ launcher fetch`. The classifier is `apps/dev/src/core/runtime-doctor.ts` (`auditRuntimes`), pure + IO-free like `hook-doctor.ts` (every cache/version fact is injected). During this read-only pass: never fetch a bundle and **never touch the network** — the audit reads observed facts, it does not resolve them.
14. **`req:<Spec>` dependency-edge audit** — dependency edges must point at executable slices, never at a Spec (see `triage-labels.md` *Dependency Edges*; #907/#928 incident). List every open issue carrying a `req:N` label whose target #N carries `type:spec`, and emit **one warn line per offending edge** (`⚠️ #<dependent> req:<N> → #<N> is type:spec — re-point at its spec:<N> slices`). Resolve it read-only: for each `req:*` label in use (`gh label list --search req:` or scan `gh issue list --label req:<n>`), check the target's labels with `gh issue view <N> --json labels`; a target with `type:spec` is a finding. Report `✅` when no `req:<Spec>` edge exists, `⚠️` with the count and per-edge lines otherwise. Tag `→ /triage` (re-point each offending edge). During this read-only pass: never edit a label.
15. **Native blocked-by vs `req:N` divergence audit** — ADR 0094 deliberately keeps two dependency surfaces: native GitHub blocked-by edges for humans and `req:N` labels for the AFK runtime. Compare them across open Tickets (exclude parent Specs carrying `type:spec`) and emit one warn line per divergent edge in either direction: native blocked-by edge without the matching `req:N` label, or `req:N` label without the matching native blocked-by edge. Report `✅` when every open Ticket's native blocked-by set equals its `req:N` label set, `⚠️` with the count and per-Ticket lines otherwise. Tag `→ /triage` (refresh dependency metadata so both surfaces match). The pure classifier is `apps/dev/src/core/dependency-edge-doctor.ts` (`auditDependencyEdges`); every GitHub fact is injected, and the check is read-only. During this read-only pass: never add/remove labels and never create/delete native edges.
16. **ask-red router coverage sync** — compare the registered dev skill names from the plugin manifest with the slash-command names covered by `plugins/dev/skills/engineering/ask-red/SKILL.md`. Emit one warn line for each registered skill missing from the router and each stale router entry that no longer names a registered skill. Report `✅` when both sets match, `⚠️` with the finding count otherwise. Tag `→ ask-red maintenance rule` (update the router's Coverage Inventory and route text). The pure classifier is `apps/dev/src/core/ask-red-router-doctor.ts` (`auditAskRedRouterCoverage`); every manifest and router fact is injected, and the check is read-only. During this read-only pass: never edit manifests and never rewrite `ask-red`.

**Scorecard** (always printed): one row per check (✅/⚠️/❌ + one-line evidence) + a readiness score (count of green checks, like `context-status`) + a prioritized recommendation list, **every recommendation carrying a fix-home tag** from the *Fix-home* table. End with the single highest-impact next step.

### Pass 2 — Fix (only with `--fix`; gated apply)

For **every** non-green finding from Pass 1, apply its canonical fix. Running with `--fix` → read [`APPLY.md`](APPLY.md) for the per-finding action and gate. There is no finding the doctor reports but cannot heal: each row maps to a concrete action or a delegation to the single-writer tool that owns it.

The loop:

1. **Group the findings** into **safe** (idempotent, low-blast-radius) and **hard-to-reverse** (per the gate column in [`APPLY.md`](APPLY.md)).
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

Canonical families live in the target repo's `.red/agents/triage-labels.md`: state (`needs-triage`, `needs-info`, `ready-for-agent`, `running`, `ready-for-human`, `wontfix`), dependency (`blocked:dependency`, `req:N`), typed blocked-reasons (`blocked:quota|runner-transient|merge-conflict|spec|validation|crashed|policy|stalled|infra`), type (`type:spec`, `type:bug`, `needs-slicing`), priority (`priority:high|low|urgent`), relationship (`spec:N`), operational (`runner-error`).

### Fix-home (every Pass-1 recommendation carries one)

| Fix-home | Findings it owns |
|---|---|
| `→ /red-setup` | AGENTS≡CLAUDE `## Agent skills` parity, AGENTS≡CLAUDE `## Development workflow` parity, `dev.lock.primary-branch` adoption, statusline drift, MCP wiring, label provisioning, `.red/.gitignore` self-ignore, workflow naming-convention drift (`reusable-*`/`rs-*`/`red-*` by role) + AFK-lane auth gap, AFK hook/backpressure static-validation findings (stale `package.json` script, missing file, unknown hook name). |
| `→ AFK runtime` | `blocked:*` accumulation (labels must be rotated/cleared on re-queue, plus the re-claim cap) — a bundle change, not a config edit. |
| `→ launcher fetch` | per-plugin runtime distribution findings (`runtime-missing`, `inert-marker`, `version-drift`, `cache-corrupt`) — the cache is owned by the launcher (`red-fetch`/`afk.mjs`, ADR 0034/0038), never hand-edited. |
| `→ /triage` | `req:<Spec>` dependency edges (check 14) — re-point each offending edge at the target Spec's executable slices; native blocked-by vs `req:N` divergence (check 15) — refresh dependency metadata so both surfaces match. `/triage` owns the authoring validation. |
| `→ ask-red maintenance rule` | ask-red router coverage sync (check 16) — update `plugins/dev/skills/engineering/ask-red/SKILL.md` when skills or flows change. |
| `→ manual / maintainer` | label renames (`gh label edit`), retiring legacy labels — the operator decides. |
| `→ release` | cross-manifest version mismatch — owned by the single-writer version script + `validate-install-metadata.sh` gate (ADR 0040); never hand-edit one manifest. |

### Scope & boundaries

- **Single repo** by default; multi-repo sweep is opt-in. With `--fix`, a sweep applies per-repo with the same gating.
- **Public-repo safe**: reads only conventions already public in the repo; **emits no secret values** (it may list secret *names* via `gh secret list` to detect the AFK-lane auth gap — names are not sensitive — and never reads or prints a value). It does **not** impose RedSkills' own `red-*` CI (release/bench/drift-guard/upstream-watch) onto an adopter repo — that stays out of scope. What it *does* audit is the **adoption coherence of `rs-*` workflows already installed** (correct installed-name + the AFK lane's auth secret), never installing a lane the repo didn't opt into.
- Pairs with `/review-adrs` (decision-record coherence) and `memory:doctor` (graph health) — three doctors over different axes; this one owns **process/adoption** and is the one that can both diagnose and, with `--fix`, heal.

</supporting-info>
