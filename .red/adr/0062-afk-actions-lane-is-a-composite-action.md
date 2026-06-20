# The AFK Actions lane is a repo-portable composite action under a thin reusable workflow

## Context

ADR 0059 introduced the AFK Actions lane — running ONE AFK attempt per issue from
GitHub Actions. The first implementation (`reusable-afk-attempt.yml`, #665, made
functional in #675) baked the execution into the reusable workflow: it invoked
`node plugins/dev/skills/engineering/afk/bin/afk.mjs` as a **workspace-relative
path**. That only resolves when the checked-out repository *is* red-skills.

When an adopter repo calls the reusable
(`uses: reddb-io/red-skills/.github/workflows/reusable-afk-attempt.yml@<ref>`),
`actions/checkout` checks out the **adopter's** repo (the event's
`github.repository`), which does not contain `plugins/dev/.../afk.mjs`. So the
lane worked only for red-skills self-hosting, not for the adopters the lane is
explicitly meant to serve.

Three concerns were tangled in one file: **triggers** (when), **trust gate**
(who), and **execution** (how). Execution was the only non-portable part.

## Decision

**Extract execution into a repo-portable composite action; keep the reusable
workflow as a thin policy layer (triggers + trust gate) on top of it.**

- **`.github/actions/afk-attempt`** (composite action) is the execution
  PRIMITIVE: set up Node, install the selected runner CLI
  (`opencode-ai` | `@anthropic-ai/claude-code` | `@openai/codex`), and run the
  launcher against the already-checked-out workspace.

  *Why a composite action makes it portable:* a `uses:
  reddb-io/red-skills/.github/actions/afk-attempt@<ref>` causes GitHub to fetch
  the red-skills tree at `<ref>` to run the action. The committed `afk.mjs`
  launcher and `plugins/dev/.claude-plugin/plugin.json` ride along under
  `${{ github.action_path }}`, so the launcher resolves its version and fetches
  the matching `dev` bundle from the Release (ADR 0038/0039) — red-castle inlined
  (ADR 0061), no workspace build, no submodule. The action runs against the
  **caller's** workspace (the target repo), while the launcher lives in the
  action's own red-skills checkout. The two are independent paths.

- **`reusable-afk-attempt.yml`** (reusable workflow) keeps the triggers
  (`issues: labeled`/`opened`, `workflow_dispatch`, `workflow_call`) and the
  ADR 0056 trust gate, then delegates execution via
  `uses: …/.github/actions/afk-attempt`. It owns policy, not execution.

- **Two adoption surfaces**, one execution primitive:
  - *Turnkey*: call the reusable (or install it directly) — triggers + trust gate
    handled (`examples/rs-afk-attempt.yml`).
  - *Composable*: `uses: …/afk-attempt@v1` in a workflow you control, with your
    own trigger and gating (`examples/red-afk-attempt-action.yml`).

- **CI invariants baked into the action:** `RED_AFK_SANDBOX=none` (never a nested
  container in Actions, overriding any target-repo `afk.sandbox` config),
  `GH_TOKEN = github.token`, a committer identity, and `--once` (one attempt, no
  fleet, no admin-merge — the PR is the deliverable).

- **Secrets via inputs.** Composite actions can't read `secrets.*`, so auth keys
  are action inputs the caller wires from its own secrets; `github.token` is read
  directly. Permissions stay minimal (`contents`/`issues`/`pull-requests: write`).

- **Reproducibility by ref.** Pinning `afk-attempt@v1` (or a SHA) fixes both the
  action and — through the plugin version in that checkout — the `dev` bundle the
  launcher fetches. The reusable references the action at `@main` (they ship
  together in red-skills); adopters wanting strict pinning use the composable path.

## Consequences

- The lane runs in **any** repo, not just red-skills. red-skills dogfoods it
  (its own `reusable-afk-attempt.yml` consumes the action).
- Execution is a testable, independently-versioned unit, decoupled from triggers
  and gating.
- No new distribution mechanism: reuses launcher + Release (ADR 0038/0039) and
  the single execution seam (ADR 0033/0061).
- Open follow-ups unchanged: #621 (allowlist from `.red/config.yaml`) and #622
  (atomic claim CAS to avoid racing a local fleet).

## Status

accepted.

## Related

- ADR 0059 — the AFK Actions lane + OpenCode as the API-auth CI runner (this
  refines its packaging).
- ADR 0038 / 0039 — the launcher + Release-fetch distribution the action reuses.
- ADR 0033 / 0061 — the single execution seam; the substrate (`@reddb-io/red-castle`)
  inlined into the `dev` bundle the launcher fetches.
- ADR 0056 — the trust gate that stays in the reusable's policy layer.
