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

## Dependency & hierarchy operations

Use GitHub's native issue relationships for the human-facing graph, and keep the RedSkills labels/body fallback in sync for AFK machinery.

### Create a native sub-issue relationship

Create the child issue first, then attach it to its parent Spec or map with the sub-issues endpoint:

```bash
child_id="$(gh api "repos/{owner}/{repo}/issues/<child-number>" --jq '.id')"
gh api --method POST "repos/{owner}/{repo}/issues/<parent-number>/sub_issues" \
  -f "sub_issue_id=$child_id"
```

For Spec slicing, also apply `spec:<parent-number>` to the child. For `/wayfinder`, the parent carries `wayfinder:map` and the child carries exactly one `wayfinder:<type>` label.

### Create a native blocked-by relationship

Use the child's dependency endpoint and pass the blocker issue's numeric database id:

```bash
blocker_id="$(gh api "repos/{owner}/{repo}/issues/<blocker-number>" --jq '.id')"
gh api --method POST "repos/{owner}/{repo}/issues/<child-number>/dependencies/blocked_by" \
  -f "issue_id=$blocker_id"
```

**Trap:** `issue_id` must be the blocker's numeric database id from the REST issue `.id` field. It is never the GitHub issue `#number`, and it is never the GraphQL `node_id`. Passing the wrong value can link the wrong issue silently.

For AFK dependencies, also apply `blocked:dependency` plus one `req:<blocker-number>` label per blocker. Keep the strict `## Blocked by` body fallback when the issue should auto-promote after blockers close.

### Read blocked-by edges for audit

Audit the actual native blocker list from the child's endpoint:

```bash
gh api "repos/{owner}/{repo}/issues/<child-number>/dependencies/blocked_by" \
  --jq '.[] | {number, id, state, title}'
```

Use this list when checking whether native blocked-by edges and `req:N` labels diverge.

### Read dependency summary counts

The REST issue payload includes `issue_dependencies_summary`. Its `blocked_by` field is an open-blocker count only:

```bash
gh api "repos/{owner}/{repo}/issues/<child-number>" \
  --jq '.issue_dependencies_summary.blocked_by'
```

`issue_dependencies_summary.blocked_by == 0` means no open blockers remain; it does not enumerate blockers and it should not replace the blocked-by audit endpoint above.

## Wayfinding operations

This repo expresses `/wayfinder` maps and tickets with GitHub Issues plus the RedSkills label vocabulary:

- The map is one GitHub issue labeled `wayfinder:map`.
- Tickets are native GitHub sub-issues of the map. Each ticket carries exactly one type label: `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- Blocking uses GitHub's native blocked-by relationship. Mirror every native blocking edge as a `req:N` label, per ADR 0094, so existing RedSkills queue and backpressure tools see the same dependency.
- Create and audit these native relationships with the commands in [Dependency & hierarchy operations](#dependency--hierarchy-operations).
- The frontier is the set of open child issues whose blockers are all closed and that have no assignee. Claim by assignment: assign yourself before working a ticket, and treat any assigned open ticket as claimed.
- AFK-typed children (`wayfinder:research` and AFK-safe `wayfinder:task`) enter the autonomous queue with `ready-for-agent` once unblocked. Blocked AFK children use `blocked:dependency` plus their `req:N` labels, not `ready-for-agent`.
- HITL-typed children (`wayfinder:grilling`, `wayfinder:prototype`, and any human-only `wayfinder:task`) use `ready-for-human` plus assignment to the expected human or role. They move back to the autonomous lane only after `/hitl` or `/retake` determines the blocker is resolved.
- An unblocked AFK-safe `wayfinder:task` is in `ready-for-agent` and can be dispatched immediately with `/afk --issues <n>`. The wayfinder session must not resolve it inline — route it to the AFK engine instead.
- If native blocking is unavailable, add a strict `## Blocked by` fallback section to the ticket body and list the blocking issue names with links. Keep the `req:N` labels in sync with that fallback.
