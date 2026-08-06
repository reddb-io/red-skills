---
name: wait-what
description: Stop and re-pitch the last reply when it did not land. Use only when the user invokes this skill.
disable-model-invocation: true
---

Re-pitch the last reply with enough context to stand on its own. Use ASD-STE100
Simplified Technical English: short sentences, one instruction per sentence,
and concrete words. Read `.red/CONTEXT-MAP.md`, find the owning
`.red/contexts/<name>/CONTEXT.md`, and use its ubiquitous language. Preserve the
meaning of the reply; replace only its explanation.
