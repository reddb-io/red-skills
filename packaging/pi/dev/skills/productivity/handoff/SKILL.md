---
name: handoff
working-mode: interactive
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

**Hand over context, not content — reference existing artifacts; do not reproduce them.** The next agent needs enough to continue, not a transcript.

Write a handoff document to a path from `mktemp -t handoff-XXXXXX.md` (read the file before writing). Cover:

- **State:** what was done, what is in progress, what is blocked
- **Next action:** the first concrete step the next session should take
- **Skills:** which skills the next session should invoke, if any
- **Refs:** paths or URLs to any Specs, plans, ADRs, issues, commits, or diffs — do not reproduce their content

Use this template:

```markdown
# Handoff — <date>

## State
<what was done / in progress / blocked>

## Next action
<the first concrete step>

## Skills to invoke
<list of /skill names, if any>

## References
- <path-or-url>: <one-line description>
```

Redact API keys, passwords, tokens, and personally identifiable information before writing.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
