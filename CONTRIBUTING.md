# Contributing to RedSkills

Thank you for your interest in RedSkills. This repository is developed
**spec-first** and runs an autonomous agent fleet (`/afk`) over its own issue
tracker, so our contribution funnel is deliberately narrow. Read this before
opening a pull request — it will save you (and us) wasted work.

## Ideas are welcome — as issues, not as surprise PRs

**The unit of contribution here is an idea, expressed as an issue.** Open an
issue describing the problem, the use case, or the improvement you have in mind.
We triage every incoming issue; good ideas are turned into a Spec, sliced into
tickets, and implemented through the normal lane — often by the agent fleet.

**Unsolicited feature pull requests are closed by policy.** A PR that lands code
without a previously discussed, accepted issue will be closed with thanks,
**regardless of quality**. This is not a judgment of the work — it is how we keep
the design coherent, the provenance clean, and the review surface safe. If the
idea is one we want, we credit you in the issue and reimplement it through the
normal lane. This mirrors the well-worn policy of large infrastructure projects:
discuss first, code second.

Concretely:

- **Bug fix, typo, or docs correction** → an issue is still preferred, but a
  small, self-contained PR that references an issue is fine.
- **New feature, new skill, new workflow, or a broad refactor** → **open an
  issue first.** Do not send the PR until the issue is accepted and pointed at
  the normal lane.

## Why fork PRs are reviewed by diff only

RedSkills is not an inert data repository. Several files in it **execute when a
checkout is made or dependencies are installed**:

- `CLAUDE.md` / agent instruction files are read and obeyed by any agent that
  opens the checkout.
- `.red/config.yaml` activates plugins, hooks, and the command proxy for the
  directory it sits in.
- `package.json` / `pnpm` lifecycle scripts run code on `install`.
- `.github/`, scaffolders, and skill hooks carry executable logic.

Because of that, **maintainers review external pull requests by reading the diff
in the GitHub UI only.** We do **not**:

- `gh pr checkout` a fork branch into a working checkout,
- `--adopt-branch` / merge a fork branch into a local worktree,
- `pnpm install`, build, or run tests **from** fork-authored code,
- let the agent fleet claim or execute fork-authored work.

An external contribution is treated as **untrusted data**: we quote what it
claims and verify it against the current codebase; we never execute it to "see if
it works". This is enforced mechanically as well as by policy — see below.

## How external origin is marked and gated (mechanics)

- **`origin:external` label.** The `red-issues-needs-triage` workflow resolves
  each new issue's and PR's author against the repository collaborator
  permission API. An author **without write access** gets an auto-created
  `origin:external` label. The check is **fail-safe**: if permission cannot be
  determined, the item is marked external.
- **AFK claim hold.** The `/afk` claim path **refuses** to execute an
  `origin:external` issue — it parks the issue as `ready-for-human` even if the
  issue somehow carries `ready-for-agent`. A maintainer with write access
  releases it by commenting **`/approve-external`**; the approver is verified
  through the same write-access trust resolver the fail-closed gate uses, so a
  non-maintainer's `/approve-external` does not release anything.
- **Untrusted-body handling.** `/triage` treats external-origin issue and PR
  bodies as data to summarize, never as instructions to obey.

See `plugins/dev/skills/engineering/red-setup/triage-labels.md` for the label
vocabulary and the full lifecycle, and `apps/plugin-dev/src/core/trust-gate.ts` for the
claim-time trust machinery (ADR 0085 / issue #1101).

## GitHub Actions fork posture

The CI/automation surface is audited to be safe against fork-reachable events
(`issues`, `issue_comment`, `pull_request`, `pull_request_review_comment`). The
posture, current as of issue #2603:

- **No `pull_request_target`.** No workflow uses the `pull_request_target`
  trigger, which would run our privileged workflow code against a fork's
  head with repository secrets in scope. This is asserted mechanically.
- **Explicit least-privilege `permissions:`.** Every workflow declares an
  explicit top-level `permissions:` block. Fork-reachable workflows request the
  minimum they need (typically `contents: read`, plus `issues: write` /
  `pull-requests: write` only where they label or comment). No fork-reachable
  workflow is left on the default token scope.
- **Trusted-ref checkouts.** Workflows reachable by untrusted events that check
  out code pin the ref to a **trusted** commit — the PR **base** SHA
  (`github.event.pull_request.base.sha`) or the repository default branch —
  **never** the PR head. Fork-authored code is never checked out and executed by
  a privileged job.
- **Secrets and fork `pull_request` jobs.** GitHub withholds repository secrets
  from workflows triggered by a fork's `pull_request` event, so a fork PR cannot
  exfiltrate them. Jobs that do need secrets (LLM API keys, the release PAT) are
  reachable only through trusted events, run only trusted (base/default-branch)
  code, and gate any privileged action behind the write-access trust resolver.
- **Best-effort fork-PR labeling.** Because a fork `pull_request` event runs with
  a read-only token, applying `origin:external` to a **fork** PR is best-effort;
  the fail-safe still marks external on any uncertainty, and the claim-time gate
  is the authoritative control regardless of whether the PR label landed.

If you find a workflow that violates this posture, please open an issue — this is
exactly the kind of report we want.

## Development conventions (for accepted work)

- **English only** in all committed content.
- **Labels** are kebab-case or `prefix:value`.
- Use **`pnpm`**; never hand-edit generated manifests (`.agents/plugins/*`,
  `plugins/*/.codex-plugin/*`, `plugins/*/package.json`) — regenerate them with
  `pnpm codex:manifests` / `pnpm pi:manifests`.
- Include a **changeset** for any user-visible change.

See `CLAUDE.md` and `README.md` for the full repository map and rules.
