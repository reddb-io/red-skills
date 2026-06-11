# AFK Actions lane — running `/afk` from GitHub Actions

The **AFK Actions lane** runs one AFK attempt per issue from GitHub Actions, in
any repository — not just `reddb-io/red-skills`. It is the same per-issue routine
as a local `/afk --issues N --once`: **one attempt, one issue, one PR per
invocation, no fleet, no admin-merge.** The PR is the deliverable; the merge
decision stays human. ADR 0059 (the lane + OpenCode as the CI runner) and ADR
0062 (the packaging below).

## Architecture — three layers

| Layer | What it owns | Artifact |
|---|---|---|
| **Trigger + policy** | *when* it runs + the trust gate | reusable workflow `red-afk-attempt.yml` |
| **Execution** | run one attempt (Node, runner CLI, launcher) | composite action `.github/actions/afk-attempt` |
| **Runtime distribution** | fetch the versioned `dev` bundle | the `afk.mjs` launcher + GitHub Release (ADR 0038/0039) |

The composite action is repo-portable: `uses:
reddb-io/red-skills/.github/actions/afk-attempt@<ref>` makes GitHub fetch the
red-skills tree to run the action, so the committed `afk.mjs` + `plugin.json`
ride along and the launcher resolves its version and fetches the matching `dev`
bundle (red-castle inlined, ADR 0061) — **no workspace build, no submodule, in
any repo.** Execution runs against the caller's checkout; the launcher lives in
the action's own checkout. Pin `@v1` (or a SHA) to fix both the action and the
bundle version.

External dependencies are only **GitHub-official** actions (`actions/checkout`,
`actions/setup-node`, `actions/github-script`) plus our own action — no
third-party action repos.

## Two ways to adopt

### A. Turnkey — the reusable workflow (triggers + trust gate included)

Drop the reusable into your repo (or call it). It ships the issue/label triggers
and the ADR 0056 trust gate. Template:
[`examples/red-afk-attempt-caller.yml`](./examples/red-afk-attempt-caller.yml).

```yaml
# .github/workflows/afk.yml in your repo
jobs:
  attempt:
    uses: reddb-io/red-skills/.github/workflows/red-afk-attempt.yml@v1
    with:
      issue_number: ${{ inputs.issue_number }}   # or wire your own trigger
      runner: opencode
      model: ""                                   # e.g. minimax/MiniMax-M2 (empty = repo config)
      allowlist_authors: "your-login"
      allowlist_label_actors: "your-login"
    secrets:
      minimax_api_key: ${{ secrets.MINIMAX_API_KEY }}
```

### B. Composable — the composite action (your triggers + gating)

Use the execution primitive directly and own the trigger/gate. Template:
[`examples/red-afk-attempt-action.yml`](./examples/red-afk-attempt-action.yml).

```yaml
on: { issues: { types: [labeled] } }
permissions: { contents: write, issues: write, pull-requests: write }
jobs:
  attempt:
    if: github.event.label.name == 'ready-for-agent'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: reddb-io/red-skills/.github/actions/afk-attempt@v1
        with:
          issue: ${{ github.event.issue.number }}
          runner: opencode
          model: minimax/MiniMax-M2            # optional override
          minimax-api-key: ${{ secrets.MINIMAX_API_KEY }}
```

## Triggers (reusable workflow)

1. `workflow_call` — a thin caller in your repo.
2. `workflow_dispatch` — manual run from the Actions UI (`issue_number` input).
3. `issues: labeled` — fires when **`ready-for-agent`** is applied.
4. `issues: opened` — fires when an issue is **created already carrying**
   `ready-for-agent` (a pre-delegated issue). Raw label-less issues are NOT run
   — they fall through to `red-issues-needs-triage` and the labeled path.

## Trust gate (ADR 0056)

The reusable refuses to claim unless the issue **author** AND the
**label-applier** (the opener, for the `opened` path) are both in the allowlist
(`allowlist_authors` / `allowlist_label_actors`). A failure logs, comments, and
exits without a claim or PR. `enforce_trust_gate: "false"` bypasses it — for
private repos only, never a public one. (Until #621, the auto-trigger path falls
back to a hard-coded maintainer allowlist.)

## Inputs

| Input | Action | Reusable | Notes |
|---|---|---|---|
| `issue` / `issue_number` | ✓ | ✓ | required |
| `runner` | ✓ | ✓ | `claude` \| `codex` \| `opencode` (CI default `opencode`) |
| `model` | ✓ | ✓ | override every tier, e.g. `minimax/MiniMax-M2` (empty = repo config) |
| `effort` | ✓ | ✓ | reasoning effort/variant override |
| `*-api-key` secrets | ✓ (inputs) | ✓ (secrets) | the auth keys — passed as **action inputs** (composite actions can't read `secrets.*`) |
| `allowlist_*`, `enforce_trust_gate` | — | ✓ | trust gate (policy layer) |

## Runner + auth

CI uses **opencode** by default — the API-auth runner with no host session (ADR
0059). It is endpoint-agnostic: the model slug's leading segment routes the
endpoint, and AFK forwards the first-set auth key. Precedence (first non-empty
wins; `""` is treated as unset):

| precedence | env / secret | slug prefix | endpoint |
|---|---|---|---|
| 1 | `OPENAI_API_KEY` | `openai/…` | OpenAI direct |
| 2 | `MINIMAX_API_KEY` | `minimax/…` | MiniMax subscription |
| 3 | `OPENROUTER_API_KEY` | `openrouter/<vendor>/…` | OpenRouter relay |

So to drive a **MiniMax** subscription: wire `minimax-api-key` and set
`model: minimax/<your-model>` — nothing else. (claude/codex runners need their
own CLIs + `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`.) Details:
[`runner-opencode.md`](./runner-opencode.md), and the model tiers/override in
[`../model-tier-policy/SKILL.md`](../model-tier-policy/SKILL.md).

## CI invariants (baked into the action)

`RED_AFK_SANDBOX=none` (never a nested container, overrides any repo
`afk.sandbox`), `GH_TOKEN = github.token`, a `github-actions[bot]` committer
identity, and `--once`. Required permissions: exactly `contents: write`,
`issues: write`, `pull-requests: write` — no `id-token`, no `actions: write`.

## What it does NOT do

No fleet, no admin-merge, no auto-merge — the human merges the PR. It also does
not yet claim atomically against a concurrently-running local fleet (#622), and
the config-sourced allowlist predicate is pending (#621).

## See also

- ADR 0059 (lane + OpenCode runner), ADR 0062 (composite-action packaging),
  ADR 0038/0039 (launcher + Release distribution), ADR 0056 (trust gate).
- [`SKILL.md`](./SKILL.md) — the local `/afk` runtime contract this mirrors.
