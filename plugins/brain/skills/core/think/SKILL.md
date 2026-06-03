---
name: think
description: Synthesize an answer from the project Brain.
---

# Think Skill

Use this when the user asks what the project Brain knows, what changed, what
supports or contradicts an idea, or how captured knowledge connects.

Call `brain_think` when MCP is available. The MVP synthesis is deterministic
over Brain search results; LLM enrichment is a later asynchronous layer.
