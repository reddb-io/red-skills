# External attacker threat model for agent execution hosts

## Status

Accepted. Records the adversarial assumptions for AFK, cloud interaction, and
other RedSkills automation that turns repository or tracker events into agent
execution on a host.

## Context

Several ADRs document pieces of the security posture: ADR 0073 frames untrusted
payloads, ADR 0085 gates executable issues, ADR 0067 keeps globally installed
plugins inert until a repo opts in, and ADR 0062 separates workflow triggers from
execution. What was still missing is the explicit attacker model tying those
controls together.

The execution host is a valuable target. A successful run may have:

- repository write credentials (`GITHUB_TOKEN`, SSH agent, or `gh` auth),
- model-provider credentials,
- local filesystem access,
- network egress,
- package-manager and workflow supply-chain reach.

The attacker modeled here is an **external actor without maintainer authority**
who can interact with public repository surfaces: issues, comments, labels they
can influence indirectly, PRs, commits in a fork, dependency metadata, and any
text that eventually appears in a handoff or review context.

## Decision

Treat external repository content as attacker-controlled input and treat the
execution host as a credential-bearing environment that must not run attacker
chosen work unless a trust gate or maintainer action opens the door.

### 1. Credential-exfiltration threat

The attacker may try to cause the agent, shell, tests, package scripts, or
review tooling to print, commit, upload, or send secrets. Relevant credentials
include GitHub tokens, SSH agent access, model-provider keys, package registry
tokens, local config files, and any process-local environment injected for a
runner.

Controls:

- untrusted text is framed and explicitly denied instruction authority (ADR
  0073);
- executable work is gated before handoff creation (ADR 0085);
- workflow permissions are least-privilege for the lane being run;
- credentials are injected process-locally where possible rather than written to
  global user config;
- refusal paths comment and stop instead of attempting partial execution.

### 2. Network-egress threat

The attacker may try to use a passing agent run, test command, package script, or
generated code path to make outbound requests that leak secrets, download a
payload, or coordinate with attacker infrastructure.

Controls:

- untrusted public work does not auto-run on public repos without maintainer
  trust (ADR 0085);
- runner lanes should keep only the network and credentials needed for the
  current operation;
- review and triage lanes stay advisory unless a trusted actor explicitly asks
  for mutation;
- logs and envelopes should report refusal or validation failures without
  dumping environment contents.

This ADR does not claim network egress is fully sandboxed today. Where stronger
isolation is required, a later implementation ADR must specify the container,
egress allowlist, and secret-mount contract.

### 3. Supply-chain threat

The attacker may try to alter dependencies, workflow references, generated
bundles, submodules, package scripts, or installer paths so that the host runs
attacker code during install, build, test, feedback, or release.

Controls:

- release bundles are versioned artifacts fetched through the launcher pattern
  rather than ad hoc source execution (ADRs 0038, 0039, 0084);
- the red-castle substrate is pinned as a submodule (ADR 0061);
- package-manager checks should use the lockfile and avoid implicit dependency
  upgrades during validation;
- workflows and reusable actions are documented as version-pinned adoption
  surfaces;
- plugin activation is explicit per directory, so a global install does not run
  in arbitrary repositories (ADR 0067).

### 4. Host compromise is out of scope for automatic recovery

If an attacker obtains host-level execution outside the RedSkills lane, the
agent runtime cannot prove recovery by itself. The correct response is credential
rotation, host rebuild, cache invalidation, and audit of pushed branches and
published releases. AFK should fail closed when it detects trust or provenance
ambiguity; it should not attempt to repair a suspected compromised host by
continuing to run agents on it.

## Consequences

- Security reviews have a named baseline: external public content is
  attacker-controlled, and the host carries secrets.
- The trust gate is a necessary pre-execution control, not a substitute for
  prompt-injection framing, least-privilege credentials, or supply-chain hygiene.
- Future slices that add new public triggers, new package execution, or broader
  network access must state how they fit this model.
- Documentation should avoid saying that public input is "safe"; it can only be
  authorized, framed, sandboxed, or refused.

## Related

- ADR 0085 — AFK trust gate.
- ADR 0073 — injection-safe untrusted payload framing.
- ADR 0062 — AFK Actions lane composite action and reusable workflow split.
- ADR 0067 — per-directory plugin activation gate.
- ADR 0061 — AFK runs on the vendored red-castle submodule.
