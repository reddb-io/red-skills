# Brain-vs-Memory boundary

Shared reference for brain and memory skills — the canonical routing table. Edit here instead of patching each skill individually.

| Dimension | Brain | Memory |
|---|---|---|
| What is stored | Human and project knowledge artifacts | Operational work facts and evidence |
| Who it serves | The human (recall, synthesis, decisions) | The agent (context packs, governed recall) |
| Store | `.red/brain/brain.rdb` | `.red/memory/graph.rdb` (or notes) |
| Skill to write | `brain capture` | `memory store` |
| Skill to read | `brain search` / `brain think` | `memory recall` |
| Examples | Person bio, open question, idea, past decision | Gotcha, why-note, validated approach |

**Route to Brain** for: biographical details, identity context, personal preferences, contact information, durable human decisions, knowledge about people and organizations, long-lived ideas, plans, and open questions — anything the user wants to recall across sessions as human-facing knowledge.

**Route to Memory** for: short operational facts from the current work session — gotchas, why-notes, code decisions, validated approaches, scoped reminders for the agent.
