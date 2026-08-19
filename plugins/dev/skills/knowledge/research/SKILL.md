---
name: research
working-mode: interactive
description: Performs deep official-source research on a technical topic and saves a structured Markdown report under `.red/researches/<YYYY-MM-DD>-<slug>.md`. Use when the user invokes `/research`, asks for official documentation, primary-source research, repository/wiki documentation, specs, or high-depth source-backed notes.
argument-hint: "<topic> [--deep] [--save-as slug]"
---

# /research

**Research a technical topic from official primary sources only, then save a structured, date-disambiguated report to `.red/researches/<YYYY-MM-DD>-<slug>.md`.**

## Source Policy

Use browsing. Prefer sources in this order:

1. Official documentation site.
2. Official repository docs, README, examples, changelog, and wiki.
3. Official GitHub/GitLab/Bitbucket Pages or docs folders.
4. Standards, RFCs, specs, or API references.
5. Official issues, discussions, and release notes when they document real behavior.

Never cite SEO blogs or Medium posts — they obscure official truth. Avoid generic tutorials, StackOverflow answers, and unofficial summaries; if the user explicitly asks for them, flag them as non-primary. If official coverage is weak, say so in the report.

## Workflow

1. Parse the topic and optional `--save-as <slug>`.
2. Search broadly, then narrow to official/primary sources.
3. Open and read the relevant pages; follow official links when they clarify API, config, behavior, versioning, or migration details.
4. Create `.red/researches/` if needed.
5. Save the report as `.red/researches/<YYYY-MM-DD>-<slug>.md`. If that path
   already exists, append a numeric suffix such as
   `.red/researches/<YYYY-MM-DD>-<slug>-2.md`; never silently overwrite an
   earlier report.
6. Reply with the saved path and the highest-signal findings.

## Report Template

```md
# <Title>

Date: <YYYY-MM-DD>
Query: <original request>
Scope: <what was included/excluded>

## Executive Summary

## Official Sources

- [Title](url) — why this is primary/official.

## Hotlinks

- [Anchor text](url) — direct link to the useful section.

## Key Findings

## API / CLI / Config Details

## Version Notes

## Gotchas

## Open Questions

## Source-by-Source Notes

## Recommended Next Steps
```

## Depth Rules

- Default: enough depth for implementation planning.
- `--deep`: follow secondary official links and include more source-by-source notes.
- `--save-as <slug>`: use the provided slug; otherwise generate a lowercase kebab-case slug from the topic.

Every factual claim in the report should be traceable to a listed official
source. Keep quoted text short; prefer paraphrase with links.
