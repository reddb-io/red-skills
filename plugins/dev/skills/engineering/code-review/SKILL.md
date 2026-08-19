---
name: code-review
working-mode: interactive
description: Two-axis code review of the diff between HEAD and a fixed point — Standards (does the code follow this repo's documented coding standards and the Fowler smell baseline?) and Spec (does it implement what the issue/Spec asked for?). Runs both reviews as parallel sub-agents. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to "review since X".
---

# Code Review

Two-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards** — does the code conform to this repo's documented coding standards, and does it avoid the universal Fowler smell baseline?
- **Spec** — does the code faithfully implement the originating issue / Spec / spec?

Both axes run as **parallel sub-agents** so they don't pollute each other's context, then this skill aggregates their findings.

The issue tracker should have been provided to you — run `/red-setup` if `.red/agents/issue-tracker.md` is missing.

<what-to-do>

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point — a commit SHA, branch name, tag, `main`, `HEAD~5`, etc. Don't be opinionated; pass it through. If they didn't specify one, ask: "Review against what — a branch, a commit, or `main`?" Don't proceed until you have it.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages (`#123`, `Closes #45`, etc.) — fetch via `gh issue view` per `.red/agents/issue-tracker.md`.
2. A path the user passed as an argument.
3. A Spec/spec file under `docs/` or `specs/` matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't one, the **Spec** sub-agent will skip and report "no spec available".

### 3. Identify the standards sources

Anything in the repo that documents how code should be written. Common locations:

- `CLAUDE.md`, `AGENTS.md`
- `CONTRIBUTING.md`
- `.red/CONTEXT.md`, `.red/CONTEXT-MAP.md`, per-context `.red/CONTEXT.md` files
- `.red/adr/` (architectural decisions are standards)
- `.editorconfig`, `eslint.config.*`, `biome.json`, `prettier.config.*`, `tsconfig.json` (machine-enforced standards — note them but don't re-check what tooling already checks)
- Any `STYLE.md`, `STANDARDS.md`, `STYLEGUIDE.md`, or similar at the repo root or under `docs/`

Collect the list of files. The **Standards** sub-agent will read them and also apply the always-on Fowler smell baseline (see `<supporting-info>`).

### 4. Spawn both sub-agents in parallel

Send a single message with two `Agent` tool calls. Use the `general-purpose` subagent for both.

**Standards sub-agent prompt** — include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3.
- The twelve-smell Fowler baseline table from `<supporting-info>`, pasted in verbatim so the sub-agent has the list without reading this skill's file.
- The brief: "Read the standards docs. Then read the diff. Report — per file/hunk where relevant — every place the diff violates a documented standard. Cite the standard (file + the rule). Distinguish hard violations from judgement calls. Skip anything tooling enforces. Also apply the always-on Fowler smell baseline table above, even when no standards doc exists. For each smell found, name it and suggest a one-line fix. Repo standards override the baseline. Under 400 words total."

**Spec sub-agent prompt** — include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Read the spec. Then read the diff. Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

If the spec is missing, skip the Spec sub-agent and note this in the final report.

### 5. Aggregate

Present the two reports under `## Standards` and `## Spec` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings — the two axes are deliberately separate so the user can see them independently.

End with a one-line summary: total findings per axis, and the worst single issue (if any) flagged.

</what-to-do>

<supporting-info>

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.

## Fowler smell baseline

These twelve smells apply universally to every review, even when the repo has no written standards. Repo-specific standards override or extend them.

| Smell | One-line fix |
|---|---|
| **Mysterious Name** | Rename to describe exactly what it does |
| **Duplicated Code** | Extract the shared logic once |
| **Feature Envy** | Move the method closer to the data it uses |
| **Data Clumps** | Bundle the recurring group into an object |
| **Primitive Obsession** | Replace bare strings/numbers with typed objects |
| **Repeated Switches** | Replace with polymorphism or a dispatch table |
| **Shotgun Surgery** | Consolidate the scattered change points into one place |
| **Divergent Change** | Split the class by its distinct responsibilities |
| **Speculative Generality** | Delete the unused abstraction |
| **Message Chains** | Introduce a method that hides the chain |
| **Middle Man** | Remove the delegator and call the real object directly |
| **Refused Bequest** | Push down the unused inheritance to the subclass that needs it |

</supporting-info>
