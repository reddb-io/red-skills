---
name: feedback-repo-english-only
description: "All content committed to the red-skills repo must be in English — code, docs, skill files, comments, CHANGES.md entries, ADRs, READMEs. User-facing chat (responses to the user) may remain in Portuguese."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 26c34665-7482-4411-b76e-b02357147e09
---

100% of content authored into the `red-skills` repository must be in English. No exceptions.

**Scope:** SKILL.md, README.md, CHANGES.md, CLAUDE.md, `.red/CONTEXT.md`, ADRs, comments inside skill template files, comments inside scripts, YAML workflow comments, examples, frontmatter `description:` fields — everything that lives in the repo.

**Why:** keeps the skill library shareable, future contributor-friendly, and consistent with the upstream `mattpocock/skills` it adapts. Avoids the maintenance burden of bilingual docs drifting out of sync. The user is fluent in English and prefers it for technical artefacts.

**How to apply:**
- When authoring new files: write English from the start.
- When editing existing files: if you find Portuguese content, translate it as part of the edit — don't leave it mixed.
- User chat can remain Portuguese (this rule is about repo content, not conversation).
- Frontmatter `description:` fields in SKILL.md files must be English (these are surfaced to the model loader).
- ADRs, CONTEXT.md, CHANGES.md entries — English.
- The only allowed non-English strings: proper nouns (`reddb.io`, `mattpocock`), shell commands, code identifiers.
