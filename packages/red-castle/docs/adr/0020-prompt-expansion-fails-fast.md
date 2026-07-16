# Prompt expansion fails fast, never retries or degrades

## Context

Issue #617 reported that a `` !`gh api graphql ...` `` shell expression in a
prompt template timed out after 30s under contention (three sandboxed agents
running in parallel), raising `PromptExpansionTimeoutError` and aborting the
whole AFK run. The same call returned in ~360ms from an unloaded shell. The
issue asked prompt expansion to behave "like a network call":

1. **Retry** transient timeouts (3 attempts, backoff).
2. **Degrade gracefully** via a `!?` best-effort marker that substitutes an
   empty string / `<expansion-failed>` instead of failing.
3. **Surface better diagnostics** on failure.

This sits against an existing tension: `execOkWithGitTimeout`
(`SandboxLifecycle.ts`) already retries — but only on transient exec exit codes
(126/137), and deliberately _not_ on timeouts ("a genuine git error or a hung
exec still fails fast"). So the house rule was never "always retry"; it was
"retry idempotent infrastructure races, fail fast on hangs and genuine errors."

## Decision

Prompt expansion fails fast on **every** failure — timeout, non-zero exit, or
transient exec code. No retry, no graceful degradation. Rejected parts 1 and 2
of the issue; accepted part 3.

The reasoning is the asymmetry with git setup, not an exception to it:

- **Git setup is idempotent plumbing.** Re-running `git worktree add` after an
  overlayfs race yields the identical result, so retrying a 126/137 is free
  correctness.
- **Prompt expansion produces content the agent acts on.** Its failures
  (contention timeout, auth/bad-query non-zero exit, a `gh` SIGKILLed under
  memory pressure) are not "same operation, try again" — they signal the
  environment cannot reliably assemble the prompt right now. Retrying risks
  either masking a real problem or feeding the agent a prompt built under a
  degraded environment. Degradation is worse still: silently dropping a missing
  fragment runs the agent against a wrong prompt, burning an iteration and
  possibly committing garbage — more expensive to recover from in an AFK
  context than a clean abort.

Retry belongs at the layer that owns the parallelism (the orchestrator), not
inside prompt assembly. To make that delegation real, accept part 3: add typed
diagnostics (`elapsedMs` on `PromptExpansionTimeoutError`, `exitCode` on
`PromptError`), surfaced in the error message, so a downstream orchestrator can
programmatically branch — timeout → retry the whole run; non-zero exit → don't
— instead of parsing strings.

## Considered Options

1. **Retry transient timeouts** — rejected. Under sustained contention 3
   attempts + backoff is ~90s of apparent hang that still fails, and a
   successful retry only means the agent runs against a prompt assembled in a
   degraded environment.
2. **Mirror git-setup and retry 126/137** — rejected. Prompt content is not
   idempotent plumbing; see above.
3. **`!?` best-effort degradation** — rejected. Running the agent against a
   knowingly-incomplete prompt is worse than not running it, and the marker adds
   security-sensitive surface to the prompt-injection machinery.
4. **Fail fast + typed diagnostics** (chosen) — keeps prompt assembly
   deterministic and hands the retry decision, with the data to make it, to the
   orchestration layer.

## Consequences

- A single slow/failed shell expression aborts the run, by design. The
  orchestration layer is responsible for any retry.
- `PromptExpansionTimeoutError` gains `elapsedMs`; `PromptError` gains
  `exitCode`; both appear in the formatted message via `ErrorHandler`.
- Prompt expansion is intentionally stricter than git setup. The distinction to
  preserve: retry is safe for idempotent infrastructure, unsafe for prompt
  content.
