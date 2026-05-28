---
name: feedback-label-naming
description: "All issue-tracker labels shipped by RedSkills must be either kebab-case (lowercase, hyphens for word boundaries) or the prefix:value form (e.g. `priority:high`, `slice:afk`, `prd:42`)."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 26c34665-7482-4411-b76e-b02357147e09
---

All issue-tracker labels authored or applied by RedSkills must follow one of two shapes:

1. **kebab-case** — lowercase letters, digits, hyphens. Single-word labels (`bug`, `enhancement`, `running`, `wontfix`) are valid kebab-case by default.
2. **prefix:value** — lowercase prefix, single `:`, lowercase value (kebab-case allowed inside the value). Use this when the label expresses a typed dimension with a value.

**Why:** consistent vocab makes labels easy to scan in the GitHub UI, easy to grep in scripts, and easy to filter with `gh issue list --label`. The two shapes communicate intent: kebab for atomic state, `prefix:value` for typed dimensions (priority, slice type, parent PRD).

**How to apply:**
- Never ship `UPPERCASE`, `CamelCase`, `snake_case`, or `Title Case` labels.
- When introducing a new typed label, prefer `prefix:value` over `prefix-value`. Reserved prefixes so far: `priority:`, `slice:`, `prd:`.
- When auditing an existing repo via `/setup-red-skills`, surface non-conforming labels and offer to rename them (`gh label edit "Old Name" --name "new-name"`).
- `gh` label matching is case-insensitive for filtering but case-preserving for storage — normalising on creation keeps the tracker clean.

**Examples:**
- ✓ `needs-triage`, `ready-for-agent`, `wontfix`, `running`
- ✓ `priority:high`, `priority:low`, `slice:afk`, `slice:hitl`, `prd:42`
- ✗ `HITL`, `AFK`, `Bug`, `prd-42`, `Ready For Agent`
