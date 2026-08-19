---
name: wiki-init
working-mode: interactive
description: Bootstrap the LLM Wiki pattern in a repo — create `.red/wiki/` layout, write `.red/agents/wiki.md` schema, gitignore wiki artifacts, register a `### Wiki` entry under `## Agent skills` in CLAUDE.md/AGENTS.md. Run once per repo before using `/wiki`. Re-run only to reset.
disable-model-invocation: true
---

# wiki-init

**Bootstrap the LLM Wiki with a short interview, then write the layout and agent schema.**

Sets up the [LLM Wiki](../wiki/REFERENCES.md) pattern. After this runs, the agent has a persistent, incrementally-maintained knowledge base inside `.red/wiki/` and a schema in `.red/agents/wiki.md` that teaches future sessions how to ingest sources, query, and lint.

<what-to-do>

## Process

Light grilling — three questions, then preview, then write. Don't dump all three at once; ask one, get the answer, move on.

### 1. Explore

Before asking anything, check:

- `.red/wiki/` — does it already exist? If yes, refuse to overwrite without an explicit `--reset` from the user.
- `.red/agents/wiki.md` — already present?
- `CLAUDE.md` and `AGENTS.md` — does either have an `## Agent skills` block?
- `.gitignore` — is `.red/wiki/` already listed?
- `gh repo view --json visibility` — sanity check (informational only; the wiki is gitignored either way).

### 2. Ask three questions

The three questions are Domain, Source types, and Voice. Walk through them one at a time and recommend a default for each before waiting for an answer.

**Q1 — Domain.** "In one sentence, what will this wiki accumulate?"
Examples: "research on LLMs applied to finance", "reading notes on The Lord of the Rings", "competitive intel on reddb.io competitors", "personal journals and self-tracking".

**Q2 — Source types you expect to feed in.** Multi-select, with defaults:
- web articles (URL fetch)
- PDFs (papers, books, reports)
- transcripts (podcasts, calls, meetings)
- personal notes (markdown drop)
- other (describe in free text)

This defines what `/wiki ingest` must support out of the gate.

**Q3 — Solo or team?**
- **Solo** → wiki voice is the user's first person; no "we", no "the team".
- **Team** → neutral/collective voice, optional `team.md` page to map stakeholders.

Default: infer from `git config user.name` + whether the repo has multiple contributors in `git shortlog -sn` (>1 → team).

### 3. Preview

Before writing, show the user:

1. The paths that will be created.
2. The rendered `.red/agents/wiki.md` (with domain/source-types/voice substitutions applied).
3. The `.gitignore` line that will be appended.
4. The `### Wiki` block that will land under `## Agent skills` in CLAUDE.md/AGENTS.md.

Wait for approval.

### 4. Write

**Create the structure:**

```
.red/
├── agents/wiki.md
└── wiki/
    ├── raw/
    │   └── assets/
    ├── pages/
    │   └── .gitkeep
    ├── index.md
    └── log.md
```

Use the seed templates bundled with this skill:
- [schema-template.md](./schema-template.md) → `.red/agents/wiki.md` (substituting placeholders `{{domain}}`, `{{source-types}}`, `{{voice}}`)
- [index-template.md](./index-template.md) → `.red/wiki/index.md`
- `log.md` starts with the heading `# Log` and nothing else.
- For the full bundled template inventory, see [TEMPLATE-REFERENCE.md](./TEMPLATE-REFERENCE.md).

**Append to `.gitignore`:**

```
# RedSkills wiki — local-only, never committed
.red/wiki/
```

If `.gitignore` doesn't exist, create it. If the line already exists (same prefix), skip.

**Update CLAUDE.md/AGENTS.md:**

Pick rules identical to `red-setup`:
- If `CLAUDE.md` exists, edit it.
- Else if `AGENTS.md` exists, edit it.
- If neither exists, ask which one to create.

Append under `## Agent skills`:

```markdown
### Wiki

Incremental LLM Wiki for accumulating knowledge about `{{domain}}`. Schema at `.red/agents/wiki.md`. Use `/wiki` for ingest, query, and lint.
```

If a `### Wiki` block already exists, update it in place instead of duplicating.

### 5. Done

Tell the user:
- What was created.
- That `.red/wiki/` is gitignored (nothing leaks).
- Next step: run `/wiki ingest <first source>`.
- That the schema is living — they can edit `.red/agents/wiki.md` directly, or ask the agent to update it as conventions emerge.

</what-to-do>

<supporting-info>

## References

- Bundled templates and examples: [TEMPLATE-REFERENCE.md](./TEMPLATE-REFERENCE.md).
- External LLM Wiki pattern reference: [REFERENCES.md](../wiki/REFERENCES.md) in the `wiki` skill.

</supporting-info>
