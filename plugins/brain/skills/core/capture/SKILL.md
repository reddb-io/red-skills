---
name: capture
working-mode: interactive
description: Save a durable human or project knowledge artifact into the Brain store. Use when the user says "capture", "save", "dump", "remember this", or any phrasing that sends personal context, ideas, decisions, or long-lived knowledge to Brain. Routes to Brain, not Memory.
---

# brain capture

Saves a typed artifact into the project Brain store (`.red/brain/brain.rdb`).
Brain holds **human and project knowledge** — who people are, what was decided, what is planned, what questions are open, what ideas matter. Memory holds **operational work facts** (gotchas, why-notes, engineering decisions) — route those to `/memory:store` instead.

<what-to-do>

**Route the user's input to the right artifact kind, call `brain_capture`, then confirm the stored artifact id.**

## 1. Identify the artifact kind

Map the user's input to the closest Brain artifact kind before capturing:

| What the user gives you | Artifact kind |
|---|---|
| A person, contact, or organization | `person` or `organization` |
| A decision that was made | `decision` |
| An open question to answer later | `question` |
| A general note or dump | `note` |
| An idea to explore | `idea` |
| A concept or explanation | `concept` |
| A plan or step sequence | `playbook` |
| A meeting record or summary | `meeting` |
| A reference, link, or source | `source` |
| A pattern or recurring approach | `pattern` |
| An event or occurrence | `event` |
| A claim to evaluate later | `claim` |
| A goal, rule, or constraint | `rule` |

When unsure, use `note`. Do not invent kinds outside the Brain vertex vocabulary.

## 2. Check the Brain-vs-Memory boundary

Confirm the content belongs in Brain before capturing — see [Brain-vs-Memory boundary](../../references/BRAIN_VS_MEMORY.md). If it is a short operational work fact (gotcha, why-note, code decision), route to `/memory:store` instead.

## 3. Capture

Call the `brain_capture` MCP tool when available:

```json
{
  "title": "<short descriptive title>",
  "kind": "<artifact kind>",
  "content": "<the full knowledge to store>"
}
```

Otherwise run:

```bash
node "${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/bootstrap.mjs" capture --title "<title>" --kind <kind> "<content>"
```

Pass `--tags tag1,tag2` if the user provides tags or the content clearly belongs to a topic cluster.

## 4. Confirm

Report the artifact id and kind that was stored so the user can reference it later with `/brain:search` or `/brain:think`. If Brain is not initialized, tell the user to run `brain init` first.

## DOs / DON'Ts

- ✅ Route personal facts, identity context, and human knowledge to Brain with this skill.
- ✅ Choose the artifact kind that best matches the content before capturing.
- ✅ Capture the full context — Brain is the long-lived store; brief stubs recall poorly.
- ❌ Don't capture secrets, raw credentials, API keys, or passwords.
- ❌ Don't use Brain for short-lived operational work facts — use `/memory:store` for those.
- ❌ Don't hand-write files under `.red/brain/` directly — go through `brain_capture` or the CLI.

</what-to-do>

<supporting-info>

### Brain artifact kinds (full vocabulary)

`pillar`, `decision`, `concept`, `question`, `playbook`, `task`, `event`, `pattern`,
`hypothesis`, `fact`, `source`, `bookmark`, `note`, `reference`, `custom`, `project`,
`idea`, `meeting`, `claim`, `organization`, `person`, `agent`, `workflow`, `rule`,
`tool`, `output`, `workspace`, `department`.

`contact` is an ingestion alias: resolve to `person` or `organization` before storing.

### Brain-vs-Memory boundary

See [Brain-vs-Memory boundary](../../references/BRAIN_VS_MEMORY.md).

### Connection kinds

After capture, Brain runs fast deterministic extraction and may suggest connections. Connection kinds: `supports`, `contradicts`, `depends_on`, `derived_from`, `related_to`, `part_of`, `preceded_by`, `followed_by`, `authored`, `tagged`.

</supporting-info>
