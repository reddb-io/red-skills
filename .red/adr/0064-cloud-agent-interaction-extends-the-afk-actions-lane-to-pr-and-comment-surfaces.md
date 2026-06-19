# Cloud agent interaction extends the AFK Actions lane to PR and comment surfaces

## Status

proposed. Captured from a `/start` grilling session (2026-06-18). The load-bearing
decisions are stable; two implementation leaves stay open (see *Open questions*).

## Context

`mattpocock/sandcastle` ships a label-driven cloud agent loop: applying an
`agent:review` label to a PR fires a GitHub Actions runner that checks out the
head SHA, runs an agent (`review.ts`), pushes fixes with `--force-with-lease`,
and walks an `agent:*` label state machine. Sibling workflows cover
`implement`, `implement-pr`, `explore`, and `update-branch`. Our fork
`packages/red-castle` already **vendors the entire `.sandcastle/agent-workflows/`
tree** (including `review/{prompt.md,extraction.md}` and the
`shared/review-context.ts` / `review-output.ts` structured-output layer) — but it
does **not** carry the `.github/workflows/agent-*.yml` that trigger them. We ship
the engine without the ignition.

Studying sandcastle, the goal that emerged is a set of cloud workflows for
**review, triage, and interaction with human comments** on the repo (bulk
**implementation** stays on the AFK fleet). Crucially, much of the execution
spine already exists and must be reused, not reinvented:

- **ADR 0059 (amended)** — OpenCode is the session-less third AFK runner;
  Amendment 1 extends its endpoint surface to any OpenAI-compatible endpoint,
  **including a MiniMax subscription**. This is the cloud substrate.
- **ADR 0062** — the **AFK Actions lane** is a repo-portable composite action
  (`.github/actions/afk-attempt`) under a thin reusable workflow
  (`red-afk-attempt.yml`) that owns *triggers + trust gate* and delegates
  *execution* to the action. Today it triggers on `issues: labeled/opened`,
  `workflow_dispatch`, `workflow_call` — the **issues/implement** surface only.
- **ADR 0056** — the trust gate (`apps/dev/src/core/trust-gate.ts`): an
  allowlist (`plugins.dev.afk.trust-gate.allowlist`) plus label provenance;
  permissive when unconfigured.
- **ADR 0038/0039** — the launcher + Release-fetch bundle distribution.
- **ADR 0061** — `@reddb-io/red-castle` is the vendored substrate inlined into the
  `dev` bundle.

The gap is therefore **not** a new cloud layer. It is: the lane reacts to
**issues** but not to **pull_request** or **comment** events; it runs an AFK
*attempt* (implement) but has no *review* or *comment-response* behaviour; the
canonical state machine (`.red/agents/triage-labels.md`) is **issue-only** with
no PR object type; and the trust gate is allowlist-only with no
CODEOWNERS/maintainer awareness.

This is a public repo. Any configuration where an agent burns a runner — or
pushes code — in reaction to an arbitrary public actor's label or comment is the
primary risk to contain.

## Decision

**Extend the existing AFK Actions lane from the issues/implement surface to the
PR and comment surfaces, adding `review` and `comment-response` as new `dev`
subcommands, an event-push trigger model alongside the pull-based fleet, a PR
object type in the unified state machine, and a CODEOWNERS layer over the trust
gate.** Concretely:

1. **Hybrid topology (event-push + pull).** The AFK fleet stays **pull-based**
   (drains the `ready-for-agent` queue) for bulk implementation. The cloud lane
   adds **event-push** reactions for the human-facing surfaces — PR review and
   comment interaction — where latency-to-human matters and a queue cannot model
   "a human replied". Implementation is not duplicated into the cloud.

2. **Reuse the lane substrate; do not adopt sandcastle's recipe.** Cloud
   reactions run through the **same composite-action + thin reusable-workflow**
   shape (ADR 0062) on the **OpenCode/MiniMax runner** (ADR 0059), via the
   launcher + dev bundle (ADR 0038). We do **not** install Claude Code with a
   `CLAUDE_CODE_OAUTH_TOKEN` as sandcastle does.

3. **Fat binary / thin event-router workflow.** Each `red-*.yml` only filters
   the event, reads `github.event` to learn *which* label/comment/PR action fired,
   and passes it as structured flags to a **new `dev` subcommand**
   (`dev review --pr N`, `dev respond --event <payload>`, `dev triage --issue N`).
   All label transitions, comment parsing, diff, write-back, and thread replies
   live in versioned, unit-tested TS — mirroring the AFK launcher, not
   sandcastle's ~80 lines of workflow bash.

4. **One unified label family; one state machine, two object types.** No separate
   `agent:*` namespace. The canonical `.red/agents/triage-labels.md` machine is
   extended so **PRs reuse the same terminal/blocked labels** (`running`,
   `ready-for-human`, `blocked:*`) and gain a single PR-entry label
   `ready-for-review`. `needs-triage` / `ready-for-agent` stay issue-only.
   Comments funnel into whichever object carries them. This keeps `/afk monitor`,
   `/hitl`, and human triage working unchanged across both object types.

5. **Tiered mutation.** Review and triage are **advisory** — they post reviews,
   comments, and label transitions, never push code (`pull-requests` / `issues:
   write`, never `contents: write`). **Comment-response** may push a commit
   **only when the triggering human comment explicitly asks** (e.g. `/dev fix`).

6. **`/dev` slash-verb summon for comments.** The agent reacts to a comment only
   when it starts with a `/dev` verb (`/dev fix`, `/dev explain`, `/dev review`,
   `/dev triage`) or @mentions the bot. The verb carries intent: `fix` → may push
   (per 5); `explain`/`review` → reply-only. Every other comment is ignored.

7. **Layered trust: CODEOWNERS/write-access base + allowlist override.** A `/dev`
   command is honoured only when the commenter passes a gate whose **dynamic
   base** is GitHub write-access / CODEOWNERS membership (the self-maintaining
   "repository maintainers" source) and whose **override** is the existing
   ADR-0056 allowlist (to grant a trusted non-collaborator command rights). An
   untrusted public `/dev` comment is rejected by the same refusal path AFK
   already ships.

8. **Trust-gated auto-triage with a maintainer-summon escape.** Issues whose
   **author** passes the gate are auto-triaged on `needs-triage`. Untrusted public
   authors' issues are **not** auto-triaged; they wait until a maintainer opens
   the manual door via `/dev triage` or a `ready-for-review`-style label. The
   trust gate is the auto-vs-manual switch; the comment/label summon is the same
   single door.

9. **Review brain = the vendored sandcastle workflow.** `dev review` ports
   `red-castle/.sandcastle/agent-workflows/review/{prompt.md,extraction.md}` and
   the `shared/review-context` / `review-output` structured layer — already
   vendored — into the subcommand. Its structured findings map ~1:1 onto "post as
   PR comments + set `blocked:*` / `ready-for-human`". The human-launched
   `/code-review` (local + ultra) is left untouched.

10. **Cloud review gates AFK's own output, configurably.** When AFK / `/ship`
    opens a PR, non-mechanical changes get `ready-for-review` and a **fresh-agent**
    review before merge (implement → different-agent reviews → merge); mechanical/
    trivial work keeps fast-merging without the review hop. The existing
    `apps/dev/src/core/issue-classifier.ts` decides which is which. This respects
    the "merge fast / no drift" rule while adding a genuine second-opinion gate
    where it pays.

11. **Placement: mechanism in red-castle, policy in `apps/dev`.** Reusable,
    policy-free **mechanism** — PR-diff review engine + `review-output` schema
    (already vendored), GitHub event parser, `/dev`-verb grammar, CODEOWNERS/
    author-association trust resolver, force-with-lease push helper — lands in
    **red-castle** (honouring the intent to evolve the shared substrate). Red-skills
    **policy** — the `.red/agents/triage-labels.md` vocabulary, trust-gate config,
    AFK handoff, and `/dev`-verb → action routing — stays in **`apps/dev`**.

12. **First slice = advisory review on `ready-for-review`.** It is advisory-only
    (no mutation to get wrong on cut one), reuses the already-vendored brain, and
    still exercises the whole spine: event-router YAML → dev-bundle fetch →
    OpenCode/MiniMax run → `review-output` schema → PR-comment write-back → the new
    `ready-for-review` state. Comment-response (mutation) and triage (issue side)
    follow incrementally.

## Consequences

- The cloud-interaction capability is an **extension of ADR 0059/0062**, not a new
  subsystem: same composite-action packaging, same OpenCode/MiniMax runner, same
  launcher + Release distribution, same trust-gate refusal path.
- The canonical state machine grows a PR object type; `.red/agents/triage-labels.md`
  and any consumer that enumerates object kinds must be updated together.
- red-castle gains durable, reusable agent-interaction mechanism; policy tweaks
  (label strings, allowlist, routing) stay single-repo in `apps/dev` and avoid the
  two-repo submodule tax.
- New trigger events (`pull_request`, `issue_comment`,
  `pull_request_review_comment`) widen the public-repo attack surface; the
  slash-verb summon (6), tiered mutation (5), and layered trust (7) are the
  containment.

## Open questions

- **MiniMax-M3-in-CI auth.** ADR 0059 wires runner auth as an action input from
  the caller's secrets; confirm the MiniMax subscription credential resolves
  headlessly in a GitHub-hosted runner before committing the lane.
- **Review → state mapping.** Define precisely: a clean review removes
  `ready-for-review` and approves? a request-changes sets `ready-for-human` or
  returns to the author? This is left to the review-slice design.
- **Further sandcastle workflows.** Whether `update-branch` (rebase PR onto main)
  and `explore` (read-only investigation) join the cloud set is deferred to a
  later phase.

## Related

- ADR 0059 — OpenCode session-less runner over OpenAI-compatible endpoints
  (MiniMax subscription via Amendment 1); the cloud substrate this extends.
- ADR 0062 — the AFK Actions lane (composite action + thin reusable workflow);
  the trigger/execution shape this reuses for PR + comment surfaces.
- ADR 0056 — the allowlist trust gate; layered here with CODEOWNERS/write-access.
- ADR 0038 / 0039 — launcher + Release-fetch bundle distribution.
- ADR 0061 — `@reddb-io/red-castle` vendored substrate inlined into the dev bundle;
  the repo that gains the reusable interaction mechanism (decision 11).
- `.red/agents/triage-labels.md` — the canonical state machine extended with the
  PR object type and `ready-for-review`.
