---
name: improve-codebase-architecture
description: Find deepening opportunities in a codebase, informed by the domain language in .red/CONTEXT.md and the decisions in .red/adr/. Use when the user wants to improve architecture, find refactoring opportunities, consolidate tightly-coupled modules, or make a codebase more testable and AI-navigable.
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is testability and AI-navigability.

## Glossary

Use these terms exactly in every suggestion. Consistent language is the point — don't drift into "component," "service," "API," or "boundary." Full definitions in [LANGUAGE.md](LANGUAGE.md).

- **Module** — anything with an interface and an implementation (function, class, package, slice).
- **Interface** — everything a caller must know to use the module: types, invariants, error modes, ordering, config. Not just the type signature.
- **Implementation** — the code inside.
- **Depth** — leverage at the interface: a lot of behaviour behind a small interface. **Deep** = high leverage. **Shallow** = interface nearly as complex as the implementation.
- **Seam** — where an interface lives; a place behaviour can be altered without editing in place. (Use this, not "boundary.")
- **Adapter** — a concrete thing satisfying an interface at a seam.
- **Leverage** — what callers get from depth.
- **Locality** — what maintainers get from depth: change, bugs, knowledge concentrated in one place.

Key principles (see [LANGUAGE.md](LANGUAGE.md) for the full list):

- **Deletion test**: imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.**
- **One adapter = hypothetical seam. Two adapters = real seam.**

This skill is _informed_ by the project's domain model. The domain language gives names to good seams; ADRs record decisions the skill should not re-litigate.

## Process

### 1. Explore (fan out across lenses)

Read the project's domain glossary and any ADRs in the area you're touching first.

Then fan out **one Explore subagent per lens** (Agent tool, `subagent_type=Explore`). Each agent walks the same target tree but hunts for one kind of friction. Don't follow rigid heuristics — explore organically within the lens:

- **shallow-modules** — modules where the interface is nearly as complex as the implementation; pass-throughs and thin wrappers.
- **concept-scatter** — where understanding one concept requires bouncing between many small modules; logic that should have **locality** but is smeared across files.
- **testability** — pure functions extracted just for testability while the real bugs hide in how they're called; parts untested or hard to test through their current interface.
- **seam-leakage** — tightly-coupled modules that leak across their seams; callers depending on implementation details.

Tell each agent to apply the **deletion test** itself before surfacing anything, and to return only its strongest candidates (cap ~2 per lens) — fewer, or none, beats weak ones. A "deleting it concentrates complexity" is the signal you want.

> **Acceleration (optional).** If dynamic workflows are available in this environment, run steps 1–2 as a workflow instead — fan the lenses out in parallel and run the vet in the background, then read back the vetted list. A reference script lives at `.claude/workflows/improve-arch-explore.js` in the RedSkills repo (saved as the `/improve-arch-explore` command for contributors); in any other repo, author the equivalent inline. **This is only a speed/parallelism win — the result is identical to the Agent-tool path, which is the baseline and must work with no workflow support at all.** Never gate the skill on workflows being on.

### 2. Vet — adversarially refute every candidate (do not skip)

Before showing the user anything, pool the candidates and put each through an **adversarial deletion-test review**: spawn a skeptic (Agent tool, `subagent_type=Explore`) whose job is to **refute** the candidate — argue that deleting/merging the modules would merely *move* complexity rather than concentrate it, that an existing ADR already settles it, or that the friction is not real. The candidate is kept **only if the refactor withstands refutation**; default to dropping it when the skeptic is uncertain.

Keep this cheap: one batched skeptic over the whole pool is enough — you do not need one agent per candidate. This stage is the quality gate; a single-pass exploration without it floods the user with plausible-but-wrong refactors. The AFK core, for instance, refuted most candidates because its "shallow" modules are deliberate seams backed by ADRs.

Discard refuted candidates silently (or mention the count). Only survivors advance.

### 3. Present surviving candidates

Present a numbered list of the deepening opportunities that survived the vet. For each candidate:

- **Files** — which files/modules are involved
- **Problem** — why the current architecture is causing friction
- **Solution** — plain English description of what would change
- **Benefits** — explained in terms of locality and leverage, and also in how tests would improve

**Use .red/CONTEXT.md vocabulary for the domain, and [LANGUAGE.md](LANGUAGE.md) vocabulary for the architecture.** If `.red/CONTEXT.md` defines "Order," talk about "the Order intake module" — not "the FooBarHandler," and not "the Order service."

**ADR conflicts**: if a candidate contradicts an existing ADR, only surface it when the friction is real enough to warrant revisiting the ADR. Mark it clearly (e.g. _"contradicts ADR-0007 — but worth reopening because…"_). Don't list every theoretical refactor an ADR forbids.

Do NOT propose interfaces yet. Ask the user: "Which of these would you like to explore?"

### 4. Grilling loop

Once the user picks a candidate, drop into a grilling conversation. Walk the design tree with them — constraints, dependencies, the shape of the deepened module, what sits behind the seam, what tests survive.

Side effects happen inline as decisions crystallize:

- **Naming a deepened module after a concept not in `.red/CONTEXT.md`?** Add the term to `.red/CONTEXT.md` — same discipline as `/start` (see [CONTEXT-FORMAT.md](../start/CONTEXT-FORMAT.md)). Create the file lazily if it doesn't exist.
- **Sharpening a fuzzy term during the conversation?** Update `.red/CONTEXT.md` right there.
- **User rejects the candidate with a load-bearing reason?** Offer an ADR, framed as: _"Want me to record this as an ADR so future architecture reviews don't re-suggest it?"_ Only offer when the reason would actually be needed by a future explorer to avoid re-suggesting the same thing — skip ephemeral reasons ("not worth it right now") and self-evident ones. See [ADR-FORMAT.md](../start/ADR-FORMAT.md).
- **Want to explore alternative interfaces for the deepened module?** See [INTERFACE-DESIGN.md](INTERFACE-DESIGN.md).
