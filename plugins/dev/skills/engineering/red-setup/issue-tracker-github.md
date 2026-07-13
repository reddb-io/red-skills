# Issue tracker: GitHub

Issues and Specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

This repo expresses `/wayfinder` maps and tickets with GitHub Issues plus the RedSkills label vocabulary:

- The map is one GitHub issue labeled `wayfinder:map`.
- Tickets are native GitHub sub-issues of the map. Each ticket carries exactly one type label: `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- Blocking uses GitHub's native blocked-by relationship. Mirror every native blocking edge as a `req:N` label, per ADR 0094, so existing RedSkills queue and backpressure tools see the same dependency.
- The frontier is the set of open child issues whose blockers are all closed and that have no assignee. Claim by assignment: assign yourself before working a ticket, and treat any assigned open ticket as claimed.
- AFK-typed children (`wayfinder:research` and AFK-safe `wayfinder:task`) enter the autonomous queue with `ready-for-agent` once unblocked. Blocked AFK children use `blocked:dependency` plus their `req:N` labels, not `ready-for-agent`.
- HITL-typed children (`wayfinder:grilling`, `wayfinder:prototype`, and any human-only `wayfinder:task`) use `ready-for-human` plus assignment to the expected human or role. They move back to the autonomous lane only after `/hitl` or `/retake` determines the blocker is resolved.
- If native blocking is unavailable, add a strict `## Blocked by` fallback section to the ticket body and list the blocking issue names with links. Keep the `req:N` labels in sync with that fallback.
