# RedSkills — Agent Instructions

Public reddb.io repository containing the engineering skills (slash commands) used with Claude Code, Codex, Gemini CLI, and similar agents.

## Origin

Adapted from [`mattpocock/skills`](https://github.com/mattpocock/skills) (MIT). Not a git fork — we copied the structure so we can diverge freely. The upstream SHA we based on is in `.upstream`. The `.github/workflows/red-upstream-watch.yml` workflow opens an issue when upstream advances.

## Structure

Skills live in `skills/`, grouped by bucket:

- `engineering/` — day-to-day code work
- `knowledge/` — knowledge accumulation and curation (LLM Wiki pattern)
- `productivity/` — general workflow, not code-specific
- `misc/` — kept but rarely used
- `in-progress/` — drafts, do not publish yet

`personal/` and `deprecated/` were removed from upstream and **must not be recreated**.

## Rules

1. Every skill in `engineering/`, `knowledge/`, `productivity/`, or `misc/` must be listed in the root `README.md` **and** in `.claude-plugin/plugin.json`. Skills in `in-progress/` appear in neither.
2. Each entry in `README.md` links the skill name to its `SKILL.md`.
3. Each bucket has its own `README.md` listing the bucket's skills with a one-line description.
4. `LICENSE` is MIT inherited from Matt — **do not change copyright attribution**.
5. `.red/CONTEXT.md` is a domain glossary, not a spec or changelog.
6. **All repo content is in English.** No Portuguese (or any other language) in committed files — SKILL.md, README, CHANGES, ADRs, comments, frontmatter descriptions. Chat with the user can stay Portuguese; the repo cannot.

## Change report vs upstream

**Whenever you modify, add, or remove a skill that came from `mattpocock/skills`, record it in `CHANGES.md`**.

Format:

```markdown
## <skill-name> (<bucket>)

- **status**: modified | added | removed | renamed-from-<original>
- **upstream**: `<short SHA if applicable>`
- **why**: <one-line reason>
- **what changed**: <short bullets>
```

When bumping the SHA in `.upstream`, review `CHANGES.md`, close the matching `upstream-drift` issue, and update recorded SHAs if we cherry-picked anything.

## Creating a new (non-Matt) skill

Use `/write-a-skill`. Mark it in `CHANGES.md` as `status: added` with `upstream: —` to make clear it's original to reddb.io.

## SKILL.md body convention

RedSkills `SKILL.md` files use two XML-style sections to separate **what the agent must do** from **reference material**. When you invoke any RedSkills skill, treat the sections like this:

- **`<what-to-do>`** — the **primary directive**. Imperative, non-negotiable. Execute the loop / steps / rules inside it literally. Do not paraphrase, do not skip steps, do not substitute "what feels right" for the explicit rules. If the section contains DOs / DON'Ts (✅ / ❌), they are hard constraints.
- **`<supporting-info>`** — **reference material, consulted on demand**. Formats, file layouts, trigger conditions, examples. Read these *when the primary directive points you here*, not as additional tasks to complete in parallel.

If a skill has only one of the two sections, the whole body is the primary directive. Skills without either tag are short enough that the entire body is the directive.

Never reorder priorities so that documentation/side-effect work in `<supporting-info>` competes with the interview / implementation / review loop defined in `<what-to-do>`.

## Agent skills

### Issue tracker

GitHub Issues on `reddb-io/red-skills`. See `.red/agents/issue-tracker.md`.

### Triage labels

Canonical kebab-case / `prefix:value` vocab — labels match their canonical role names. See `.red/agents/triage-labels.md`.

### Domain docs

Single-context — `.red/CONTEXT.md` + `.red/adr/` at the repo root. See `.red/agents/domain.md`.
