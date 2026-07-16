# TASK

Explore the repo to triage issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}

This is a read-only first pass. You are not implementing the change. Your job is to help a future implementer by assessing how hard the change would be, whether the issue's claims hold up, and what someone would need to know before starting.

# ISSUE

{{ISSUE_CONTEXT}}

# CONTEXT

Read the project's domain and architecture docs to ground your assessment:

- `CONTEXT.md`
- `docs/adr/` if relevant
- `.red-castle/CODING_STANDARDS.md`

# EXPLORATION

Explore the repo to build an accurate picture. You are encouraged -- but not required -- to cover:

- **Difficulty**: how hard the change looks, and why.
- **Relevant files**: where the change would most likely land.
- **Claims**: whether assertions the issue makes are actually true -- verify them against the code.
- **Open questions**: anything an implementer must resolve before starting.
- **Possible approach**: a sketch of how it might be implemented.

Include only the topics you have something useful to say about. Omit the rest -- do not pad.

You MAY:

- Read any file.
- Run `npm run typecheck`, focused tests, `git log`, or `git blame` to ground your assessment.

You MUST NOT:

- Edit files, commit, or push.
- Create or edit PRs.
- Edit labels.
- Post comments yourself -- the workflow posts your findings.

When complete, output `<promise>COMPLETE</promise>`.
