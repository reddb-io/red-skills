---
name: hitl
description: Resolve one ready-for-human issue by extracting the pending human decision, recording the maintainer answer as Human guidance, and moving the issue back to ready-for-agent when it becomes delegable.
argument-hint: "[--issue N | --skip N,N]"
---

# HITL

Drain the human-in-the-loop decision queue without doing manual implementation.

The **HITL queue** is open, non-PRD Issues labelled `ready-for-human`. PRDs (`type:prd`) are planning artifacts and are never selected by this workflow.

<what-to-do>

## Step 1 — Select a HITL issue

List open candidates:

```bash
gh issue list --label ready-for-human --state open --limit 200 --json number,title,labels,body,createdAt
```

Filter and order:

1. Drop any Issue carrying `type:prd`.
2. If `--issue N` was passed, use that Issue only after verifying it is open, `ready-for-human`, and not `type:prd`.
3. Otherwise sort by priority band, then age:
   - `priority:urgent`
   - `priority:high`
   - everything else
4. Within each band, oldest first (`createdAt`; fall back to issue number when needed).
5. If `--skip N,N` was passed, skip those numbers for this invocation.

Present the recommended Issue:

```text
Recommended HITL issue: #N <title>
```

If the maintainer says `skip`, repeat Step 1 with that issue number added to the skipped set. If the queue is empty, say so and stop.

## Step 2 — Read the full issue thread

Fetch the selected Issue body and all comments:

```bash
gh issue view N --json number,title,body,labels,comments,url
```

Use existing RedSkills precedence:

1. **Human guidance** from `<details data-kind="directive">` comments is authoritative.
2. The issue body is next. If `## Current blocker` contains a `red:blocker-state v1` block with `status: blocked`, treat its `next:` field as the active pending decision.
3. Previous AFK **Envelopes** explain why the Issue entered `ready-for-human`.
4. Thread discussion without a Directive block is advisory only.

## Step 3 — Extract the pending decision

Try to identify a single pending decision from:

- explicit issue-body sections such as `## Human decision needed`, `## Decision needed`, `## Pending decision`, or `## HITL decision`;
- the machine-readable `## Current blocker` block (`<!-- red:blocker-state v1 --> ... <!-- /red:blocker-state -->`);
- `## Agent brief` language explaining why the Issue cannot yet be delegated;
- latest Directive block comment;
- latest AFK Envelope with status `blocked`, `no-sentinel`, or `merge-conflict`;
- advisory thread discussion only when it contains one clear question or decision point.

Ignore this loop's own prior HITL-resolution directives when extracting: skip any `<details data-kind="directive">` block whose `<summary>` is `HITL resolution`, or whose first useful line is a bare field label such as `Pending decision:`, `Human answer:`, `Disposition:`, or `Next pending decision:`. Those echo the placeholder header rather than a real decision, so re-reading them on a re-loop would surface the literal string `Pending decision:` instead of the real `## Current blocker` next-field.

If exactly one pending decision is clear, present it:

```text
Pending decision:
<decision>
```

If the decision is ambiguous, ask the maintainer to state the pending decision directly before continuing. Do not guess.

## Step 4 — Get the maintainer answer and disposition

Ask for the answer to the pending decision.

Then decide whether the answer makes the Issue delegable:

- **Delegable** means a complete `## Agent brief` can now be written and an AFK agent can execute without guessing.
- **Non-delegable** means another human decision remains.

If delegable, draft the refreshed `## Agent brief` before mutating anything.

If non-delegable, draft the next pending decision before mutating anything.

## Step 5 — Confirm the mutation plan

Show the maintainer the exact planned changes:

- Directive block comment to post.
- Body update, if any.
- Labels to add.
- Labels to remove.

Wait for explicit approval before writing.

## Step 6 — Apply the resolution

Always post a Directive block comment:

```markdown
<details data-kind="directive">
<summary>HITL resolution</summary>

Pending decision:
...

Human answer:
...

Disposition:
delegable | non-delegable

Next pending decision:
...   <!-- only when non-delegable -->
</details>
```

If delegable:

1. Clear the issue-body `## Current blocker` section to `None` and add a checked entry under `## Resolved blockers`.
2. Update or create the issue-body `## Agent brief` section.
3. Remove `ready-for-human` and every stale `blocked:*` label — the blocker is resolved, so the reason that parked the issue must not survive into `ready-for-agent`.
4. Add `ready-for-agent`.

If non-delegable:

1. Keep or add `ready-for-human`.
2. Do not add `ready-for-agent`.
3. Update or create `## Current blocker` with the next pending decision.
4. Make sure the Directive block names the next pending decision.

## Hard rules

- Do not select `type:prd` Issues.
- Do not use historical slice-routing labels; HITL queue membership is `ready-for-human`.
- Do not do manual implementation as the default path. The goal is decision resolution and delegation.
- Do not update labels or body before showing the mutation plan and receiving explicit approval.
- Do not treat Thread discussion as authoritative when it conflicts with Human guidance.
- Do not move an Issue to `ready-for-agent` unless the refreshed `## Agent brief` is sufficient for autonomous execution.

</what-to-do>
