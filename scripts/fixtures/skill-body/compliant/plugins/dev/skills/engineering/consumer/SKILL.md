---
name: consumer
description: A sibling skill that owns a shared template. Use when checking that cross-skill bundled files stay out of the orphan report.
---

# consumer

This skill folder bundles a template file that is referenced by the sibling
`good` skill rather than here — its own SKILL.md deliberately never names the
file. The plugin-wide reference search keeps it out of the orphaned-file report.
