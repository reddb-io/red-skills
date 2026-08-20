---
name: what
working-mode: interactive
description: Re-pitch the last reply so it stands on its own, in plain human language. Use only when the user invokes this skill.
disable-model-invocation: true
---

Re-pitch the last reply with enough context to stand on its own, in the words
one human uses with another. Follow ASD-STE100 Simplified Technical English:
write short sentences, put one instruction in each sentence, and use concrete
words. Drop the jargon — when a project term is
unavoidable, say in plain words what it means the first time it appears. Read
`.red/CONTEXT-MAP.md`, find the owning `.red/contexts/<name>/CONTEXT.md`, and
use its ubiquitous language for those project terms. Preserve the meaning of
the reply; replace only its explanation.
