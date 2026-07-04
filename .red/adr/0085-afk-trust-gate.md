# AFK trust gate: executable issues require trusted provenance before host execution

## Status

Accepted. Records the trust gate implemented for issue #621 and reconciles the
older phantom references that called it "ADR 0056". ADR 0056 remains the AFK
landability reconciler; this ADR is the executable-issue trust gate.

## Context

AFK can turn GitHub state into code execution on a developer host or in an
execution environment. The dangerous edge is not the label name by itself; it is
the transition from public tracker input to:

- creating a worktree and handoff,
- injecting issue bodies, comments, PR descriptions, and diffs into an agent,
- exposing process environment credentials to the runner,
- pushing branches, opening PRs, and mutating issue labels/comments.

Before the trust gate, a public actor could try to steer the pipeline by filing
an issue or arranging for `ready-for-agent` to appear on it. ADR 0073 protects the
prompt boundary by tagging untrusted payloads, but it does not decide whether an
issue is allowed to become executable work. ADR 0066 arbitrates which worker wins
a claim, but it also assumes the candidate is eligible to execute.

The repo therefore needs a decision record for the pre-claim policy check that
was referenced in workflows and docs as a missing "ADR 0056".

## Decision

Introduce an **AFK trust gate** that decides whether an issue is executable
before any runner work starts.

### 1. Gate before execution side effects

The gate runs before the promotion to `running` and before any worktree, handoff,
agent process, or feedback worktree is materialized. A refusal releases the claim
and skips the candidate; no branch is created and no untrusted payload is given to
the agent as an executable task.

### 2. Provenance inputs are resolved from GitHub, not labels alone

The executable-issue predicate reads:

- the issue author, from the issue object,
- the actor who applied `ready-for-agent`, from the issue timeline,
- the repo trust policy, from `.red/config.yaml` and repository visibility.

The current mutable label set is not enough to prove trust. The actor who
promoted the issue is part of the authority chain.

### 3. Configured allowlist is strict

When `plugins.dev.afk.trust-gate.allowlist` is configured, the gate is strict:
both the issue author and the `ready-for-agent` promoter must be allowlisted.
This mode is visibility-independent. It is the right posture for public repos,
shared automation, and any environment where an issue label can trigger host
execution.

### 4. No-allowlist default is visibility-aware

When no allowlist is configured:

- private or undeterminable repositories stay permissive, preserving the
  single-maintainer local workflow;
- public repositories fail closed. The author and promoter must resolve as
  trusted maintainers through write access, CODEOWNERS membership, or an
  allowlist override.

Untrusted public work is held for a maintainer summon instead of auto-claimed.

### 5. Same trust resolver feeds adjacent surfaces

Comment commands, trust-gated triage, and the Actions lane reuse the same trust
concept instead of inventing parallel checks. The trust gate is the
auto-vs-manual switch; explicit maintainer action is the escape hatch for
otherwise untrusted input.

### 6. Reconcile old references

Historical references to "ADR 0056 trust gate" should read this ADR. References
to ADR 0056 as landability reconcile or no-agent salvage continue to point to
ADR 0056.

## Consequences

- A public actor cannot make an issue executable merely by filing it or causing a
  stale `ready-for-agent` label to exist.
- Trust is auditable: refusal logs can name whether the author or promoter failed
  the gate and which posture was active (`strict`, `fail-closed`, or
  `permissive`).
- The policy intentionally gates execution, not prompt contents. ADR 0073 still
  frames all external text as untrusted even when the issue passes this gate.
- The local single-maintainer path remains low-friction unless the repo is public
  or an allowlist is configured.

## Related

- ADR 0073 — untrusted payload framing; protects the prompt boundary after a
  trusted issue becomes executable.
- ADR 0066 — GitHub-native claim arbitration; decides which worker owns an
  already-eligible issue.
- ADR 0062 — AFK Actions lane; keeps triggers and trust policy in the reusable
  workflow while delegating execution to the composite action.
- ADR 0086 — external-attacker threat model; names the broader host threats this
  gate partially mitigates.
- Issue #621 — implementation source for the executable-issue predicate.
