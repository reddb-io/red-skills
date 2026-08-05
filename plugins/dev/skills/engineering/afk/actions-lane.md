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
| **Trigger + policy** | *when* it runs + the trust gate | reusable workflow `reusable-afk-attempt.yml` |
| **Execution** | run one attempt (Node, runner CLI, launcher) | composite action `.github/actions/afk-attempt` |
| **Runtime distribution** | fetch the versioned `dev` bundle | the `afk.mjs` launcher + GitHub Release (ADR 0038/0039) |

The composite action is repo-portable: `uses:
reddb-io/red-skills/.github/actions/afk-attempt@<ref>` makes GitHub fetch the
red-skills tree to run the action, so the committed `afk.mjs` + `plugin.json`
ride along and the launcher resolves its version and fetches the matching `dev`
bundle (red-castle inlined, ADR 0061) — **no workspace build, no submodule, in
any repo.** Execution runs against the caller's checkout; the launcher lives in
the action's own checkout. Pin `@v1` to track the latest compatible v1 release,
or pin a SHA when the caller needs a fully immutable action/runtime pair.

External dependencies are only **GitHub-official** actions (`actions/checkout`,
`actions/setup-node`, `actions/github-script`) plus our own action — no
third-party action repos.

## Two ways to adopt

### A. Turnkey — the reusable workflow (triggers + trust gate included)

Drop the reusable into your repo (or call it). It ships the issue/label triggers
and the ADR 0085 trust gate. Template:
[`examples/rs-afk-attempt.yml`](./examples/rs-afk-attempt.yml).

Install the caller as `rs-afk-attempt.yml` (the `rs-*`
installed-name convention — see [WORKFLOWS.md](../red-setup/WORKFLOWS.md);
only the filename changes, the `uses:` ref keeps the `reusable-` source name).

```yaml
# .github/workflows/rs-afk-attempt.yml in your repo
jobs:
  attempt:
    uses: reddb-io/red-skills/.github/workflows/reusable-afk-attempt.yml@v1
    with:
      issue_number: ${{ inputs.issue_number }}   # or wire your own trigger
      runner: opencode
      model: ""                                   # e.g. minimax/MiniMax-M3 (empty = repo config)
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
          model: minimax/MiniMax-M3            # optional override
          minimax-api-key: ${{ secrets.MINIMAX_API_KEY }}
```

## Triggers (reusable workflow)

1. `workflow_call` — a thin caller in your repo.
2. `workflow_dispatch` — manual run from the Actions UI. Pass an `issue_number`, **or leave it empty to auto-pick the oldest open `ready-for-agent` issue** (the queue head). If the queue is empty the run is a clean no-op.
3. `issues: labeled` — fires when **`ready-for-agent`** is applied.
4. `issues: opened` — fires when an issue is **created already carrying**
   `ready-for-agent` (a pre-delegated issue). Raw label-less issues are NOT run
   — they fall through to `red-issues-needs-triage` and the labeled path.

## Trust gate (ADR 0085)

The reusable refuses to claim unless the issue **author** AND the
**label-applier** (the opener, for the `opened` path) are both in the allowlist
(`allowlist_authors` / `allowlist_label_actors`). A failure logs, comments, and
exits without a claim or PR. `enforce_trust_gate: "false"` bypasses it — for
private repos only, never a public one. (Until #621, the auto-trigger path falls
back to a hard-coded maintainer allowlist.)

## Inputs

| Input | Action | Reusable | Notes |
|---|---|---|---|
| `issue` / `issue_number` | ✓ | ✓ | the reusable accepts it **empty** on `workflow_dispatch`/`workflow_call` → auto-picks the oldest open `ready-for-agent` issue (no-op if none); the composite action needs an explicit number |
| `runner` | ✓ | ✓ | `claude` \| `codex` \| `opencode` (CI default `opencode`) |
| `model` | ✓ | ✓ | override every tier, e.g. `minimax/MiniMax-M3` (empty = repo config) |
| `effort` | ✓ | ✓ | reasoning effort/variant override |
| `lanes` | ✓ | ✓ | execution-lane tag (`actions`\|`k8s`), surfaced as `RED_AFK_LANE` for observability; default `actions` |
| `runs_on` | — | ✓ | runner label for the attempt job; default `ubuntu-latest`. Set e.g. `blacksmith-2vcpu-ubuntu-2404` to run on Blacksmith (see below). Composable path: set the job's own `runs-on:` directly. |
| `*-api-key` secrets | ✓ (inputs) | ✓ (secrets) | the auth keys — passed as **action inputs** (composite actions can't read `secrets.*`) |
| `allowlist_*`, `enforce_trust_gate` | — | ✓ | trust gate (policy layer) |

## Runner host — GitHub-hosted or Blacksmith

The attempt job runs on `ubuntu-latest` (GitHub-hosted) by default. To run it on
[Blacksmith](https://blacksmith.sh) managed runners — a drop-in, faster, cheaper
host — pass the `runs_on` input the matching label:

```yaml
with:
  runs_on: blacksmith-2vcpu-ubuntu-2404   # smallest Blacksmith tier
```

`blacksmith-2vcpu-ubuntu-2404` is the **smallest** Blacksmith shape — there is no
"nano"; 2 vCPU is the floor (other shapes: `-4vcpu-`, `-8vcpu-`, …). The
**Blacksmith GitHub App must be installed on the org/repo** first — a Blacksmith
label with no app installed leaves the job **queued forever**. red-skills' own
`rs-afk-attempt.yml` caller uses `ubuntu-24.04` because the repository is public.

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

## Configuring secrets (per provider)

Pick **one** provider, wire **its** key, and set a matching `model` slug. The
resolver takes the first key that is set, so wiring more than one just makes the
precedence above decide.

| Provider | Repo secret | `model` slug | Caller wiring |
|---|---|---|---|
| MiniMax | `MINIMAX_API_KEY` | `minimax/MiniMax-M3` | `secrets: { minimax_api_key: ${{ secrets.MINIMAX_API_KEY }} }` |
| OpenAI | `OPENAI_API_KEY` | `openai/<model>` | `secrets: { openai_api_key: ${{ secrets.OPENAI_API_KEY }} }` |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter/<vendor>/<model>` | `secrets: { openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }} }` |

**Repo vs org secret.** A **repo** secret is simplest; an **org** secret is
preferred when several org repos run the lane (set it once — mind the public-repo
*Repository access* caveat in the gotcha below). Don't keep both a repo **and** an
org secret of the **same name** on one repo: the repo secret wins, so the two can
silently drift — pick one.

Set the key (the value is yours to provision — RedSkills never sets it for you):

```bash
gh secret set MINIMAX_API_KEY --repo OWNER/REPO     # paste the key when prompted
```

> **⚠️ Public-repo gotcha — org secrets don't reach public repos by default.**
> GitHub does **not** expose organization secrets to a public repository unless
> the secret's **Repository access** explicitly includes it. An org secret left
> at the default scope resolves to an **empty string with no error** — the lane
> fires, `opencode` starts, and auth fails as if the key were never set. If your
> repo is public, either:
> - set the key as a **repo secret** (`gh secret set … --repo OWNER/REPO`), or
> - open the org secret's *Repository access* and add the repo (or set it to
>   *All repositories*).
>
> Verify it actually reached the repo: `gh secret list --repo OWNER/REPO` should
> list the key. An empty list on a public repo is the tell-tale of this gotcha.

The `claude` / `codex` runners are not API-key-only — they need their own CLI on
the runner plus `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. The CI default is
`opencode` precisely because it is pure API-auth.

## CI invariants (baked into the action)

`RED_AFK_SANDBOX=none` (never a nested container, overrides any repo
`afk.sandbox`), `GH_TOKEN = github.token`, a `github-actions[bot]` committer
identity, and `--once`. Required permissions: exactly `contents: write`,
`issues: write`, `pull-requests: write` — no `id-token`, no `actions: write`.

## Issue ↔ PR link (auto-close on merge)

The PR body carries `Closes #<issue>`, so GitHub links the PR to the issue and
**auto-closes the issue when the PR is merged** into the default branch — the
human just merges, no separate close step. (The local admin-merge lane closes the
issue itself; both are idempotent.)

## What it does NOT do

No fleet, no admin-merge, no auto-merge — the human merges the PR (merging
auto-closes the linked issue, above). It also does not yet claim atomically
against a concurrently-running local fleet (#622), and the config-sourced
allowlist predicate is pending (#621).

## See also

- ADR 0059 (lane + OpenCode runner), ADR 0062 (composite-action packaging),
  ADR 0038/0039 (launcher + Release distribution), ADR 0085 (trust gate).
- [`SKILL.md`](./SKILL.md) — the local `/afk` runtime contract this mirrors.
