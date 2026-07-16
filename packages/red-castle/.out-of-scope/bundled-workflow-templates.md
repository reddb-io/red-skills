# Large bundled workflow templates (e.g. superpowers / freecc)

Sandcastle does not ship large, opinionated third-party workflow templates as built-in `sandcastle init` options — for example a "superpowers"/"freecc" template that bundles its own set of skill files, coding standards, and multi-phase prompts.

## Why this is out of scope

The built-in templates (`blank`, `simple-loop`, `parallel-planner`, `parallel-planner-with-review`, `sequential-reviewer`) are deliberately minimal, framework-agnostic starting points. They exist to demonstrate the orchestration shapes Sandcastle supports, not to encode any particular external methodology.

A bundled superpowers-style template is a different thing: it ships a large tree of skill markdown, review prompts, and standards that track an external project's conventions. In-tree, that becomes a maintenance burden (the bundled copies drift from upstream) and an implicit endorsement of one workflow over others. It's also big — dozens of files — relative to the focused templates around it.

The extension points already cover this:

- **The `custom` template / scaffold path** lets a user bring their own prompts and structure at init time.
- **The template directory format is plain files**, so an opinionated workflow can be distributed as its own template pack or repo and dropped in, versioned on its own cadence rather than pinned to Sandcastle's releases.

So large external workflows live outside the curated built-in template set.

## Prior requests

- #627 — "Python node with freecc superpowers"
