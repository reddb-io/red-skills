---
name: wayfinder
description: Wayfinder maps work too large for one agent session into a shared tracker map. Use when a goal has real fog, needs research/grilling/prototype/task children, or should enter the RedSkills AFK/HITL queues without losing scope.
argument-hint: "[destination or issue/URL/path to map]"
---

# Wayfinder

**Chart one shared map for work too large for one agent session, then route each frontier child through the normal RedSkills queues.** The map fixes destination and fog; child Tickets do the work.

<what-to-do>

## 1. Check For Real Fog

Start breadth-first. Read the current conversation and any referenced issue, URL, or path. Ask or answer only the first few scope questions needed to decide whether the work has unresolved in-scope fog.

**Zoom-as-needed loading.** Load the map at low resolution — read only the map's section headings first; fetch the full body of a specific child only when the session's work touches it.

Use the **no-fog early exit**: if the opening breadth-first grilling surfaces no fog, stop and ask the user to continue with `/start`, `/to-spec`, `/to-tickets`, `/go`, or `/afk` instead of creating a map nobody needs. A map is warranted only when there is named destination plus multiple unknowns that cannot be cleared in one session.

## 2. Create The Map Ticket

Create exactly one map Ticket and label it `wayfinder:map`. Name the destination first; it fixes scope.

The map body must carry these headings:

```markdown
## Destination

The named end state. Keep this concrete enough that later child Tickets can decide whether new fog is in scope.

## Decisions so far

One line per closed child: a short gist of the decision or result followed by a link to the child Ticket. Built up by step 5 as children resolve.

## Not yet specified

In-scope fog. Each entry is a frontier question or unresolved branch that can graduate into a child Ticket.

## Out of scope

Ruled beyond the destination. These entries never graduate into child Tickets unless the destination is explicitly renamed.

## Notes

Standing preferences for this effort and which skills every session should consult.
```

The map is an **index, not a store**. Keep durable decisions, evidence, prototypes, and implementation notes in the child Tickets that produced them; the map only gists and links to those Tickets via `## Decisions so far`.

**Refer by name.** Every reference to a map or child Ticket uses its *title* with the link embedded in the name — never a bare `#N`. Bare-number narration is illegible to anyone reading the trail.

## 3. Publish Child Tickets

Children are native sub-issues of the `wayfinder:map` Ticket. Give each child exactly one wayfinder type label:

- `wayfinder:research` - AFK-typed. Use for factual discovery that can be done without a human decision.
- `wayfinder:grilling` - HITL-typed. Use for decision branches that must route to a `/start` session.
- `wayfinder:prototype` - HITL-typed. Use for design/logic uncertainty that must route to a `/prototype` session and be claimed by assignment.
- `wayfinder:task` - AFK-typed. Use for implementation or docs work that is already scoped to one agent session.

Each child must be scoped to one session. If a child still contains multiple frontier questions, split it before publishing.

Use native tracker edges plus RedSkills labels:

- Create the native sub-issue relationship from the map to every child.
- Create native blocking edges between children when order matters.
- Mirror every blocker with one `req:N` label per blocking Ticket, per ADR 0094.
- Keep the strict `## Blocked by` fallback section on blocked children.

## 4. Route Children

AFK-typed children (`wayfinder:research`, `wayfinder:task`) flow through the standard `ready-for-agent` claim machinery unchanged:

- If unblocked, add `ready-for-agent`.
- If blocked, add `blocked:dependency` plus `req:N` labels. Do not add `ready-for-human` for dependency waits.

HITL-typed children (`wayfinder:grilling`, `wayfinder:prototype`) route to humans:

- Add `ready-for-human`.
- Assign the human or role expected to run the `/start` or `/prototype` session.
- Use `## Current blocker` / `## Human decision needed` for the pending decision or prototype question, not `## Blocked by`, unless closing concrete dependency Tickets is enough to make the child delegable.

**One-ticket-per-session discipline.** A grilling or prototype session resolves exactly one HITL child and stops. Charting the map is itself one session's work. Do not collapse multiple HITL children into a single session.

When a HITL child becomes delegable, `/hitl` or `/requeue` moves it into `ready-for-agent`; do not create a parallel queue.

## 5. Advance The Frontier

After a child resolves, update the map only as an index:

- Link the child under the relevant `## Not yet specified` entry or remove the fog entry if the child answered it.
- Add a short gist of the decision or result with a link to the child Ticket into `## Decisions so far`.
- Move newly discovered in-scope fog into `## Not yet specified`.
- Move rejected branches into `## Out of scope`.

Never copy full decisions, research logs, prototype output, or implementation notes into the map. Those live in the child Tickets.

</what-to-do>

<supporting-info>

## Ticket Templates

### Map Ticket

```markdown
## Destination

<named end state>

## Decisions so far

<!-- populated by step 5 as children resolve — one line per closed child -->

## Not yet specified

- <in-scope fog item>

## Out of scope

- <ruled-out branch>

## Notes

- <standing preference or skill every session should consult>
```

Labels: `wayfinder:map`.

### Child Ticket

```markdown
## Parent

Wayfinder map #N

## What to resolve

<one-session research question, grilling branch, prototype question, or task>

## Acceptance criteria

- [ ] <observable completion condition>

## Blocked by

- [ ] #N
```

Omit `## Blocked by` when there are no blockers. Use native sub-issue and native blocked-by relationships alongside the label/body mirrors.

</supporting-info>
