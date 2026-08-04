# 0134 — The castle speaks for itself

- **Status**: accepted
- **Date**: 2026-08-04
- **Related**: ADR 0120 (the castle MCP is the canonical interface), ADR 0130 (the `redskilled` daemon; rule 3, rule 6), ADR 0132 (one render, one GitHub owner), issues #3247 (every "not registered" surface knows the verb and none names it), #3163 (eleven daemon verbs, all project-scoped), #3158 (a refusal reported as silence), the `triage:summon` incident of 2026-08-04 (a refusal message naming a cure no code reads)

## Context

Three sessions in two days got lost in the same place, each differently.

**An agent that did everything right still dead-ended.** A fresh `/afk` on a second repository read the skill, reached the MCP, dispatched a Worker — and the statusline answered `project unknown — never registered on this host`, with no hint that registration was a different verb (`project_start`), or that a single dispatch needs no registration at all. The choreography lives in SKILL.md prose; the tool surface itself routes nobody. Forty-plus verbs, and the first-time caller must already know which one begins.

**A refusal message named a cure that does not exist.** The trust gate holds a bot-authored issue with *"held for maintainer summon"*, and the repository's own tooling vocabulary contains a `triage:summon` label. A session applied it. No code reads that label; "summon" appears only inside refusal prose. The executable cure — the `origin:external` label plus a maintainer `/approve-external` comment (#2603) — is named nowhere in the message. The operator followed the words and the words were wrong.

**A correct refusal cost a session an hour.** `project_start` refuses a second registration while one stands — right, in general — and the session that hit it had no way to say "then make the standing one match this request." The verb models creation; the caller's intent was a state.

Underneath all three: the surface grew by accretion. `worker_status` and `worker_vitals` answer one question at two granularities; `monitor` overlaps both; `project_start` and `project_resize` are one intent split across two verbs; and every schema loads into every agent's context on every session, on hosts (Codex) with no deferred loading.

## Decision

**1. One front door: `drain {runner, target?}`, with ensure semantics and a difference report.** The verb makes a state true — daemon reachable, project registered at the target, queue flowing — and calling it is never an error: an unchanged state answers with a report, a changed target resizes, a lapsed registration is re-created. The response always states what changed against what already stood ("registration: kept; target: 4→6; workers born: 2"), so ensure never becomes a black box. The one refusal it keeps is a **runner change**, the single genuinely destructive switch — it kills the standing runner's Workers, so it stays an explicit, named refusal with a structured repair.

**2. One live source of choreography: the `help` tool, situational first.** `help` reads the host's real state — daemon, registration, queue, workers, last refusal — and answers "you are HERE; next is THIS verb with THESE args", pasteable, then closes with a short intent map of the surface. It is the ONLY place operating choreography lives at runtime. This decision is load-bearing for every other one: a second live source is how the `triage:summon` incident happened, and the drifted copy is always the one somebody follows.

**3. MCP prompts exist and are thin.** Per-intent prompts (`castle:drain`, `castle:diagnose`, `castle:configure`, `castle:stop`) make the surface discoverable as slash entries in Claude Code and Codex. Each is a few lines: call `help`, follow what it says. Prompts are doors, never manuals — restating choreography in a prompt reintroduces the drift decision 2 exists to end.

**4. The surface consolidates for real, with deprecation aliases.** Sibling verbs merge into intent verbs — `status {scope: worker | project | host}` absorbs `worker_status`/`worker_vitals`/`monitor` and, by carrying the `host` scope, resolves #3163's whole complaint; `project_start`/`project_resize` fold into `drain`. Old names survive one release as aliases that answer AND name their replacement, then go. A smaller advertised surface is itself a correctness feature: schemas are context every agent pays for, and forty choices is how the right one is missed.

**5. Every refusal and empty state carries a structured repair.** `repair: {tool, args, why}` — a cure the agent can invoke directly — beside the human sentence. The field is the mechanism, so the stated cure and the executable cure cannot diverge by construction. A refusal with no cure declares `repair: none` with its reason. A ratchet test holds every new refusal to one or the other, the same way the declared-wait guard holds every sleep.

**6. The work lands as one Spec absorbing #3247 and #3163.** Sequenced: repairs and `help` first (they fix today's pain without breaking anything), the front door second, prompts third (they point at `help`, which must exist), consolidation last (it needs the alias release window).

## Consequences

**What gets cheaper.** The first-call experience stops requiring the choreography: an agent holding only the tool list reaches a running fleet through `drain`, or asks `help` and is told where it stands. The `triage:summon` class of incident — message ≠ mechanism — becomes unrepresentable where `repair` is enforced. Context cost per session drops with the advertised surface.

**What gets more expensive.** Every consumer of the merged verbs migrates within one release window — `/afk`, `/go`, the herdr plugin, the VS Code extension, fleet.md and MCP.md docs. The aliases make it gradual; the window makes it bounded. `help` becomes a hot read path against host state and must stay cheap (it reads what `project_status` already reads; it must never fetch).

**What must not happen.** `drain`'s ensure must never absorb the runner switch — an ensure that silently kills another runner's Workers is the daemon's own "silently replacing the first" failure, inverted. And prompts must stay thin: the first prompt that inlines choreography is the first fork of the truth, and the guard for decision 5 cannot see prose.
