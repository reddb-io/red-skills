# CHANGES — Divergences from upstream

Records every change made to skills inherited from [`mattpocock/skills`](https://github.com/mattpocock/skills), plus new skills created by reddb.io. See the rules in [CLAUDE.md](./CLAUDE.md).

Upstream base: `mattpocock/skills@66898f60e8c744e269f8ce06c2b2b99ce7660d5f` (reviewed 33 commits after v1.1.0; see `.upstream`).

---

## wayfinder, red-setup, red-doctor (engineering) — the type label ships with its HUMAN-ONLY declaration (issue #3013)

- **status**: modified
- **upstream**: `66898f6` (upstream `wayfinder`)
- **why**: The `wayfinder:grilling` / `wayfinder:prototype` label and the `afk.labels.hitl_types` declaration are one protection with two halves (#2966). Installing the labels and leaving the declaration as a manual step ships the trigger without the safety — worse than shipping neither, because the repo LOOKS protected while every unblocked decision Ticket enters the autonomous queue.
- **what changed**:
  - `wayfinder/SKILL.md`: the HITL-type paragraph now routes label creation through `red-skills-dev install-type-labels`, which writes both halves, and forbids bare `gh label create` for a type label.
  - `red-setup/triage-labels.md` and `red-setup/INTERVIEW.md`: type-label provisioning goes through the same installer; the *HUMAN-ONLY types* section states the pair rule and the doctor check that enforces it.
  - `afk/docs/CONFIG.md`: the `hitl_types` block names the installer instead of reading as a hand-written step.
  - `red-doctor/SKILL.md` + `APPLY.md`: new check 25 — an installed HUMAN-ONLY type label with no declaration is a finding, merged under `--fix --yes` after a diff preview; a repo with no `.red/config.yaml` is delegated to `/red-setup`.

## afk (engineering) — the Unblock Sweep gets its own belt, outside the boot suite (issue #3014)

- **status**: modified
- **upstream**: —
- **why**: On a repo operated through live sessions only, a dependent kept `blocked:dependency` after a human closed its last `req:*` blocker. The close cascade fires only when the *agent* closes the blocker; the boot-time Unblock Sweep is awake in the resident janitor but is step 7 of a suite that aborts before it on a failing precheck, a red operational probe, or a stranded `.red/` doc. The promote path was reachable in principle and starved in practice.
- **what changed**:
  - `docs/BOOT-SWEEPS.md`: a new *Unblock belt* section naming each clearer that was expected, why each could not fire, and the belt that replaces the dependency on the boot suite.

## afk (engineering) — `project_start` registers the project instead of launching it (issue #2902)

- **status**: modified
- **upstream**: —
- **why**: ADR 0130 Amendment 4's two-player model, from the operator's side — the MCP registers, the daemon drives. Beginning work on a repository must create no process of the project's own.
- **what changed**:
  - `MCP.md` and `fleet.md`: the `project_start` row now says it registers this project with the host daemon and launches no process of the project's own, instead of describing the supervisor it spawned.
  - The tool's own description follows the same wording, and `project_stop` now says it gives the registration back.

## red-statusline, red-setup (engineering) — the host displays the Worker line instead of rendering it (issue #2928)

- **status**: modified
- **upstream**: —
- **why**: ADR 0130 rule 10 moved Worker rendering onto the daemon so no agent host would grow a second renderer, and the daemon does serve a finished string. But the installed `.claude/settings.json` adapter resolved the dev bundle and formatted Workers inside it, so the retired renderer was the one actually on screen — and the daemon's own local mode answered `project unknown 0w idle` on a host holding three of that repository's Workers.
- **what changed**:
  - The Claude Code adapter recipe is now two producers, each printing the rows it owns: `<dev bundle> statusline --no-workers` for the repo header, then `redskilled statusline` echoed verbatim for the Worker rows. `refreshInterval` in the `/red-setup` copy corrected from 5 to 60, matching HOST-NOTES.
  - `statusline --no-workers` added to the dev bundle's producer: additive, so the Codex footer and every non-daemon host are unchanged.
  - `apps/redskilled/tests/statusline-host-adapter.test.ts` pins the contract by SEARCHING the shipped documents, so a fourth copy of the recipe inherits it on landing, and proves the printed line is the daemon's string byte for byte.
  - Behind it: one authority for a directory's project label (`@reddb-io/shared/project-identity-resolve.js`), `project unknown` reserved for a directory no known project matches, a render bound that is a function of the declared taste alone, and a stated absence when no daemon answers.

## adr-editor (engineering) — the editor opens with a subject interview (issue #2915)

- **status**: modified
- **upstream**: —
- **why**: Phase 0 scoped the run to "all ADRs by default", so a plain `/adr-editor` swept the whole collection and dumped buckets, groups, and inconsistencies nobody asked for. The maintainer was out of the loop exactly where their judgment is cheapest to collect.
- **what changed**:
  - Phase 0 is now **Interview for the subject**: derive the choices with an unfiltered `groupAdrs` call, then ask one question offering the collection's real INDEX themes, title-term clusters, and ungrouped singletons as numbered choices with record counts.
  - Phase 1 is now **Answer about the chosen subject** — the three read-only entry points run under the agreed subject filter and the report covers the chosen slice and nothing outside it.
  - "Everything" survives as the last explicit choice, never a silent default; a subject already named in the invocation skips the question and is echoed back instead.
  - Two hard rules added — "Ask first, sweep second" and "Ask with the collection's own subjects in hand" — and the ambiguity rule sharpened to "one question per turn, each narrowing the last".
  - Unchanged by design: `triageAdrs`, `groupAdrs`, and `detectAdrInconsistencies` keep identical contracts (text-only change, no planner touched); Phase 3's single destructive-or-wide confirmation stays; `/to-spec` stays an offered escape hatch.
  - `apps/dev/tests/adr-editor-docs.test.ts` gained the interview-first assertions; `ask-red`'s route and the engineering README entry repointed; Pi packages regenerated.

## adr-editor (engineering) — the ADR skill becomes a totipotent editor (issue #2695)

- **status**: renamed-from-review-adrs
- **upstream**: —
- **why**: The one skill that owns the `.red/adr/` collection was the least able to change it. ADR 0112 made it a read-only detector whose merge, split, renumber, and supersede operations could only become a Spec routed through `/to-spec` → `/to-tickets` → `/afk`, and forbade rewriting a `## Decision` outright. The maintainer owns the record and is present in the session; the routing was friction, not safety.
- **what changed**:
  - `plugins/dev/skills/engineering/review-adrs/` → `plugins/dev/skills/engineering/adr-editor/`, body rewritten from scratch under the new charter: the maintainer decides, the skill executes.
  - Eleven first-class in-session operations: list, group by subject, surface inconsistencies, add, remove, rewrite (including `## Decision`), merge, split, archive, renumber, re-index.
  - Removed: the read-only default, the mechanical/judgment split, the "judgment operations are never applied in-session" rule, the mandatory Spec routing, and the supersede-and-replace-only rule. `/to-spec` survives as an offered escape hatch for genuinely large batches.
  - Kept: one confirmation before a destructive or wide batch, a coherent `.red/adr/INDEX.md`, `start/ADR-FORMAT.md`, and the normal branch/worktree/PR flow.
  - `apps/dev/src/core/adr-triage.ts` gained `groupAdrs` (INDEX themes, then title-term clusters) and `detectAdrInconsistencies` (numbering collisions, dangling supersede pointers, supersession cycles, INDEX drift, unrecorded supersession, stale paths, subject overlap).
  - `apps/dev/src/core/adr-operations.ts` gained `planRenumber`/`applyRenumber`, `planIndexEntry`, and `planSplit`/`planMerge`/`applyComposite` with reverse-order rollback.
  - ADR 0127 records the decision; ADR 0112 is archived as `superseded-by: 0127`; `.red/adr/INDEX.md` reflects both.
  - `apps/dev/tests/review-adrs-docs.test.ts` → `apps/dev/tests/adr-editor-docs.test.ts`, assertions repointed to the new prose.
  - Registrations updated in `README.md`, `plugins/dev/skills/engineering/README.md`, and `plugins/dev/.claude-plugin/plugin.json`; cross-references repointed in `ask-red`, `red-doctor`, `to-spec`, `to-tickets`, and ADRs 0040/0060/0112/0123. Codex and Pi manifests regenerated. No alias, stub, or deprecation shim was left behind.

## triage / red-setup (engineering) — external-origin untrusted-data + `/approve-external` gate (issue #2603)

- **status**: modified
- **upstream**: —
- **why**: Fork PR #2598 exposed a gap in the funnel against untrusted external contributions. The claim path now mechanically holds `origin:external` issues until a maintainer approves, and the triage docs must treat external bodies as untrusted data.
- **what changed**:
  - `plugins/dev/skills/engineering/triage/SKILL.md`: added a top-level directive that external-origin issue/PR bodies are untrusted data — quote, never obey — and that an `origin:external` issue is held out of the executable queue until a maintainer posts `/approve-external`.
  - `plugins/dev/skills/engineering/red-setup/triage-labels.md`: documented the `origin:external` provenance label (added to the mapping table) and the `/approve-external` claim-gate mechanics.
  - Pi mirrors regenerated under `packaging/pi/dev/skills/...`.

## afk / go / ask-red / red-doctor (engineering) — MCP servers get colon-free names (issue #2405)

- **status**: modified
- **upstream**: —
- **why**: Codex rejects `:` in MCP server names, so every `dev:*` form was unusable. The MCP is the castle manager and `afk` names only one of its clients, so the AFK server becomes `castle`; `code-nav` becomes `navigator` for the same colon-free, role-named treatment.
- **what changed**:
  - `plugins/dev/.mcp.json`: `dev:afk` → `castle`, `code-nav` → `navigator`; error strings follow. Host tool prefix becomes `mcp__plugin_dev_castle__*`.
  - Launcher `hooks/afk-mcp.sh` → `hooks/castle-mcp.sh`; bundle `afk-mcp.bundle.min.mjs` → `castle-mcp.bundle.min.mjs`; npm bin `red-skills-afk-mcp` → `red-skills-castle-mcp`; `readBuildInfo("afk")` → `"castle"` and `readBuildInfo("code-nav")` → `"navigator"`.
  - `afk/MCP.md`, `afk/SKILL.md`, `afk/fleet.md`, `afk/monitor.md`, `go/SKILL.md`, `ask-red/SKILL.md`, `red-doctor/SKILL.md`, and `README.md` name the new servers; `/dev:afk …` slash-command forms are untouched (they name the skill, not the server).
  - Codex and Pi manifests regenerated; `scripts/validate-install-metadata.sh` now asserts both the `navigator` and `castle` launcher entries.

## afk / go / ask-red (engineering) — CLI and skills become `dev:afk` MCP clients (issue #2309)

- **status**: modified
- **upstream**: —
- **why**: ADR 0120 makes the `dev:afk` MCP the canonical complete interface to every red-castle capability; `/afk`, `/go`, and the CLI are clients of it rather than owners of their own castle access paths.
- **what changed**:
  - Added `plugins/dev/skills/engineering/afk/MCP.md` — the client contract: the tool surface by domain, host tool-name prefixing, mutation modes, and the CLI-fallback rule.
  - `/afk` SKILL.md, `fleet.md`, and `monitor.md` name the tool that serves each verb (`queue_status`, `worker_dispatch`, `fleet_create`/`fleet_edit`/`fleet_status`/`fleet_stop`, `logs`, `monitor`, `worker_vitals`) and keep the CLI form as the documented fallback; fleets are now named profiles.
  - `/go` SKILL.md dispatches through `worker_dispatch` / `worker_request` / `runner_steer`.
  - `ask-red` routes "operating the castle itself" to the MCP and registers `MCP.md` as the owning capability reference.
  - `apps/dev/tests/castle-mcp-client-docs.test.ts` keeps `MCP.md` in bijection with the server's registered tools and their mutation modes.

## wayfinder (engineering) — research children stay in the AFK fleet (issue #1699)

- **status**: not-adopted
- **upstream**: `66898f6` (upstream `wayfinder`; 33-commit delta from `d574778f`)
- **why**: Upstream now starts in-session `/research` subagents in parallel while charting a wayfinder map. RedSkills deliberately routes research children through the AFK fleet instead: isolated worktrees, shared validation gate, and PR-backed results are the stronger contract for repo-affecting autonomous work.
- **what changed**: Reviewed upstream commit `2602257` and recorded the divergence. No upstream skill content was imported in this slice; future syncs must not replace the AFK fleet route with in-session research subagents.

## skill metadata — per-skill `agents/openai.yaml` files not adopted (issue #1699)

- **status**: not-adopted
- **upstream**: `66898f6` (upstream `agents/openai.yaml` metadata; 33-commit delta from `d574778f`)
- **why**: Upstream added hand-authored Codex metadata beside every skill. RedSkills derives Codex plugin manifests from the canonical plugin manifests with `scripts/generate-codex-manifests.mjs`, keeping host metadata generated and checked instead of duplicating per-skill files.
- **what changed**: Reviewed upstream commit `697d4ce` and recorded the divergence. No `agents/openai.yaml` files were added; future syncs should preserve the generated-manifest path unless that generator contract changes.

## to-tickets (engineering) — upstream local-file mode remains irrelevant (issue #1699)

- **status**: not-adopted
- **upstream**: `66898f6` (upstream `to-tickets` local tracker; 33-commit delta from `d574778f`)
- **why**: Upstream changed its local-file tracker to write one markdown file per ticket. RedSkills publishes tracked work to GitHub Issues, adds native sub-issue and dependency edges, and uses `ready-for-agent`, `blocked:dependency`, and `req:N` labels for AFK queue semantics, so upstream's local markdown storage shape is not part of our runtime contract.
- **what changed**: Reviewed upstream commit `44eed54` and recorded the divergence. No local-file ticket mode was imported in this slice; GitHub Issues remains the supported publication surface for RedSkills backlog slices.

---

## wayfinder (engineering) — AFK task dispatch to autonomous lane (issue #1830)

- **status**: modified
- **upstream**: `66898f6` (upstream `wayfinder`)
- **why**: Wayfinder was describing AFK-typed Task tickets as driven inline by the session, contradicting the RedSkills autonomous-lane contract where repo-mutating work runs in isolated worktrees through the shared gate.
- **what changed**: In `plugins/dev/skills/engineering/wayfinder/SKILL.md`, changed the Task type dispatch sentence to state that the session never executes repo-mutating task work inline — when AFK-safe it routes the ticket into the autonomous queue per the tracker doc, and the AFK engine runs it (isolated worktree, shared validation gate, PR); HITL branch unchanged. In `plugins/dev/skills/engineering/red-setup/issue-tracker-github.md` Wayfinding operations, added a bullet naming `/afk --issues <n>` as the immediate dispatch command and stating the wayfinder session must not resolve AFK-safe tasks inline.

---

## red-gains (engineering) — added (issue #1583)

- **status**: added
- **upstream**: —
- **why**: Original reddb.io skill for reading rsp usage-gains telemetry and explaining whether the wrapper is paying for itself.
- **what changed**: Added `/red-gains`, registered it in the dev skill manifests and inventories, routed it through `/ask-red`, and paired it with the new `rsp gains` report surface.

---

## doctor (engineering) — renamed to red-doctor (issue #1480)

- **status**: renamed-from-doctor
- **upstream**: —
- **why**: Align skill name with the `red-` prefix convention used by other reddb-original skills in the engineering bucket.
- **what changed**: Renamed directory `plugins/dev/skills/engineering/doctor` → `red-doctor`; updated frontmatter `name:` to `red-doctor`; updated all live references (root README, bucket README, plugin.json, ask-red router, doctor fix-home tags, cross-referencing SKILL.md files and docs, source TypeScript, test files, and compiled bundles). ADR history left untouched.

## setup-red-skills (engineering) — renamed to red-setup (issue #1480)

- **status**: renamed-from-setup-red-skills
- **upstream**: —
- **why**: Align skill name with the `red-` prefix convention for the dev-plugin skill set.
- **what changed**: Renamed directory `plugins/dev/skills/engineering/setup-red-skills` → `red-setup`; updated frontmatter `name:` to `red-setup`; updated all live references (root README, bucket README, plugin.json, ask-red router, cross-referencing SKILL.md files and docs, sub-documents, source TypeScript, test files, and compiled bundles). ADR history left untouched.

## setup-statusline (engineering) — renamed to red-statusline (issue #1480)

- **status**: renamed-from-setup-statusline
- **upstream**: —
- **why**: Align skill name with the `red-` prefix convention for the dev-plugin skill set.
- **what changed**: Renamed directory `plugins/dev/skills/engineering/setup-statusline` → `red-statusline`; updated frontmatter `name:` to `red-statusline`; updated all live references (root README, bucket README, plugin.json, ask-red router, cross-referencing SKILL.md files and docs). ADR history left untouched.

---

## wiki, wiki-init (knowledge → memory) — relocated to the memory plugin (issue #1387)

- **status**: modified
- **upstream**: —
- **why**: The LLM Wiki is a knowledge surface, not an engineering one; it belongs next to the other memory skills rather than inside `dev`.
- **what changed**: Moved `plugins/dev/skills/knowledge/{wiki,wiki-init}` to `plugins/memory/skills/core/`, re-registered them in the memory manifest, and repointed every cross-reference (root README, bucket READMEs, CLAUDE.md/AGENTS.md schema-template path, `/start`, `/ask-red`). The `knowledge/` bucket keeps `/research`.

---

## review (engineering) — removed (issue #1387)

- **status**: removed
- **upstream**: —
- **why**: The HTML-artifact annotation-bridge review skill was unused; `/code-review` is the one review verb for diffs and the browser-review draft stays in `in-progress/`.
- **what changed**: Deleted `plugins/dev/skills/engineering/review/`, its manifest entry, and its README listings.

---

## ship (engineering) — removed (issue #1387)

- **status**: removed
- **upstream**: —
- **why**: `/ship` was retired by ADR 0081 and had survived only as a deprecation stub plus a `dev ship` CLI redirect. The rollout is over.
- **what changed**: Deleted the stub skill and its manifest entry, dropped the `dev ship` alias from the CLI, removed `/ship` from the dev plugin description, and repointed the live mentions (retake's printed next-action, config template, command-guard comment, monitor prompt) at the requeue landing lane. ADR and CHANGES history left untouched.

---

## urgent (engineering) — removed (issue #1387)

- **status**: removed
- **upstream**: —
- **why**: The issue-minting front door added a command for what a single label already does.
- **what changed**: Deleted `plugins/dev/skills/engineering/urgent/`, its manifest entry, and its README listings. The `priority:urgent` queue mechanics in red-castle/AFK are untouched: a manually-labelled urgent Ticket still jumps ahead of every `--spec` / `--issues` filter.

---

## retake (engineering) — merged with requeue; diagnose-then-act (issue #1387)

- **status**: modified
- **upstream**: —
- **why**: `/retake` diagnosed an issue's state and `/requeue` acted on it; splitting diagnosis from action let operators fire a requeue at an issue whose work already sat finished in a dirty worktree.
- **what changed**: Rewrote `/retake` as one diagnose-then-act skill — reconstruct the state (PRs, branches, worktrees, uncommitted/unpushed work, HITL state, blocker), report a verdict, then execute exactly one transition (plain requeue, `--adopt-branch` landing, or handoff to `/hitl`). Removed the `/requeue` skill with no deprecation stub; the `requeue` bundle CLI command (ADR 0055) is unchanged and is what the merged skill invokes.

---

## afk (engineering) - no-leak contract and guard layers (issue #1366)

- **status**: modified
- **upstream**: —
- **why**: AFK handoffs and prompt text did not explicitly bind inner agents to redact host paths, secrets, and Claude session links from public output and commit history.
- **what changed**: Added the no-leak contract to `AGENT-PROMPT.md` and the generated exit protocols, added command-guard deny rules for leaked `gh` writes, and installed an AFK-owned `commit-msg` hook that rejects Claude session links and sensitive environment variable values before they enter history.

---

## setup-statusline (engineering) - progressive-disclosure host recipe extraction (issue #1362)

- **status**: modified
- **upstream**: —
- **why**: `setup-statusline/SKILL.md` carried shared statusline architecture and full per-host adapter recipes in the hot path instead of keeping the host-routing loop lean.
- **what changed**: Leaned `plugins/dev/skills/engineering/setup-statusline/SKILL.md` into a host-selection and action procedure with `<what-to-do>` / `<supporting-info>` tags, moved the shared architecture, Claude Code command-backed adapter, Codex footer adapter, OpenCode no-install note, and host rationale into `HOST-NOTES.md` behind resolving links, and re-checked `ask-red` coverage. No router change was needed because this was not a skill add, rename, removal, or flow change.

---

## wiki-init (knowledge) - progressive-disclosure template reference extraction (issue #1362)

- **status**: modified
- **upstream**: —
- **why**: `wiki-init/SKILL.md` mixed the bootstrap interview/write loop with reference-only bundled template inventory.
- **what changed**: Added `<what-to-do>` / `<supporting-info>` tags, kept the wiki initialization loop and required seed-template instructions hot, moved the bundled template/example inventory into `TEMPLATE-REFERENCE.md`, and verified the external `../wiki/REFERENCES.md` link remains the resolving LLM Wiki reference.

---

## setup-red-skills (engineering) - progressive-disclosure split (issue #1360)

- **status**: modified
- **upstream**: —
- **why**: `setup-red-skills/SKILL.md` was the densest remaining engineering skill entrypoint, with the whole interview and implementation manual in the hot path instead of a real progressive-disclosure split.
- **what changed**: Leaned `plugins/dev/skills/engineering/setup-red-skills/SKILL.md` into a hot-path controller with `<what-to-do>` / `<supporting-info>` tags, moved the full setup scope, interview, write contract, and issue-sweep mechanics into co-located reference docs behind resolving links, and re-checked `ask-red` routing coverage. No router change was needed because this was a documentation extraction, not a skill add, rename, removal, or flow change.

---

## write-a-skill (productivity) - progressive-disclosure split and structural-tag lint hardening (issue #1358)

- **status**: modified
- **upstream**: `d574778` (v1.1.0)
- **why**: `write-a-skill/SKILL.md` carried the full sentence-level technique catalog and Steering failure-mode material in the hot path, and the body-tag linters accepted `<what-to-do>` inside fenced examples as if it were a real structural split.
- **what changed**: Moved the nine writing-style techniques plus Negation and Negative Space Steering failure modes into `plugins/dev/skills/productivity/write-a-skill/WRITING-STYLE.md` behind a hot-path pointer, added real structural tags to `SKILL.md`, retargeted the CLAUDE.md style pointer, hardened the shell and TypeScript linters to count only standalone tags outside fenced code blocks, widened orphan-reference checks to sibling markdown reference docs, and linked AFK's fallback `runner-hermes.md` from the AFK runner reference list so the widened sweep has no runner-doc orphan.

---

## wayfinder (engineering) - fidelity-max restoration for upstream-faithful testing (issue #1702)

- **status**: modified
- **upstream**: `66898f6` (upstream `wayfinder`)
- **why**: /wayfinder needed to match upstream HEAD closely enough to test the flow as designed, with only RedSkills-required renames and tracker mechanics moved out of the skill. The normal `<what-to-do>` / `<supporting-info>` house convention is explicitly waived for this file in favor of upstream fidelity.
- **what changed**: Rewrote `plugins/dev/skills/engineering/wayfinder/SKILL.md` around the upstream structure and voice, including `disable-model-invocation: true`, Plan-don't-do, Refer-by-name, map-body ordering, question tickets, claim-by-assignment, native blocking, Fog of war, Out of scope semantics, and the two invocation modes. Applied the mandated RedSkills command substitutions while keeping `/research` and `/prototype`. Added the RedSkills-specific map, child, blocking, frontier, claim, and queue mechanics to `plugins/dev/skills/engineering/red-setup/issue-tracker-github.md`.

---

## afk (engineering) - post-extraction relative-link repair and link guard (issue #1354)

- **status**: modified
- **upstream**: —
- **why**: `plugins/dev/skills/engineering/afk/docs/OPERATIONS.md` moved one directory deeper during the progressive-disclosure extraction, but several links still resolved from the old `afk/` directory.
- **what changed**: Repaired the extracted operations reference links to sibling docs, parent AFK docs, runner docs, and setup-red-skills/model-tier references. Added a repo-wide local markdown link audit for `plugins/` plus fixture coverage so broken relative links fail the lint surface.

---

## wiki-init (knowledge) - REFERENCES link repair (issue #1354)

- **status**: modified
- **upstream**: —
- **why**: `wiki-init/SKILL.md` pointed at `./REFERENCES.md`, but the references file belongs to the sibling `wiki` skill.
- **what changed**: Retargeted the LLM Wiki reference link to `../wiki/REFERENCES.md`; the new local markdown link audit covers this class of cross-skill reference.

---

## wayfinder (engineering) - upstream voice pass: fog, frontier, and route language (issue #1350)

- **status**: modified
- **upstream**: `d574778` (v1.1.0)
- **why**: RedSkills had restored the upstream /wayfinder mechanics but its prose had flattened the upstream leading-word vocabulary around fog of war, frontier, charting, and the route becoming clear.
- **what changed**: Rewrote `plugins/dev/skills/engineering/wayfinder/SKILL.md` to carry the upstream wayfinding voice while preserving the RedSkills AFK/HITL routing contract, map sections, no-fog early exit, refer-by-name rule, one-ticket-per-session discipline, zoom-as-needed loading, and `index, not a store` invariant.

---

## write-a-skill (productivity) - Steering glossary import: leading word, completion criterion, premature completion (issue #1350)

- **status**: modified
- **upstream**: `d574778` (v1.1.0)
- **why**: The RedSkills writing-style framework had adopted sentence-level techniques but had not yet woven in the remaining upstream Steering glossary concepts that explain how those techniques steer runtime behavior.
- **what changed**: Integrated Leading Word, Completion Criterion, and Premature Completion into the existing ninth writing-style technique in `plugins/dev/skills/productivity/write-a-skill/SKILL.md`, keeping the guidance as part of the nine-technique framework instead of appending a loose glossary dump. Added a docs-contract assertion pinning the imported terms.

---

## afk (engineering) - upstream Steering taxonomy pass (issue #1343)

- **status**: modified
- **upstream**: —
- **why**: The AFK skill had become the densest entrypoint in the repo and violated the upstream Steering guidance around Progressive Disclosure. Operators need the load-bearing route and safety rules first, with reference-only runtime detail available on demand.
- **what changed**: Leaned `plugins/dev/skills/engineering/afk/SKILL.md` into a progressive-disclosure entrypoint, kept the validation-authority and core operating directives in the hot path, and extracted the full operational reference text into `plugins/dev/skills/engineering/afk/docs/OPERATIONS.md` behind pointer links. Re-checked `ask-red` routing coverage; no route inventory change was needed because this was not a skill add, rename, removal, or flow change.

---

## wayfinder (engineering) — fidelity restoration: Decisions so far, Notes, refer-by-name, one-ticket-per-session, zoom-as-needed (issue #1342)

- **status**: modified
- **upstream**: `d574778` (v1.1.0)
- **why**: Side-by-side audit found four gaps between our adopted /wayfinder and the upstream v1.1.0 design: missing map sections (`## Decisions so far`, `## Notes`), no refer-by-name rule, no one-ticket-per-session discipline for HITL children, and no zoom-as-needed loading directive.
- **what changed**:
  - Map body template (step 2 and Map Ticket template) now carries all five sections: Destination, Decisions so far, Not yet specified, Out of scope, Notes — with descriptions for each.
  - Step 5 explicitly records gists into `## Decisions so far` (was: generic "add a short gist").
  - "Refer by name" directive added to step 2: titles with embedded links, never bare `#N`.
  - "One-ticket-per-session discipline" added to step 4 HITL section: one HITL child per session; charting is one session's work.
  - "Zoom-as-needed loading" directive added to step 1: load map at low resolution, fetch child bodies on demand.
  - Docs-contract test (`label-vocabulary-docs.test.ts`) extended with a second `it` block pinning all four restored directives.

---

## to-tickets (engineering) — file-disjunction rule: serialize overlapping slices (issue #1336)

- **status**: modified
- **upstream**: —
- **why**: Spec #1333 root cause 1 — file-overlapping concurrent slices produce inherent merge conflicts at landing that no runtime can recover. The slicing skill lacked a rule directing the slicer to express file-level dependencies as `req:N` edges, leaving parallelism decisions to the slicer's judgment with no safety net.
- **what changed**: Step 3 of `plugins/dev/skills/engineering/to-tickets/SKILL.md` now carries a "File disjunction check" paragraph directing the slicer to inspect parallel slices for file-set overlap and serialize entangled pairs with `req:N` edges. Added a matching Hard Rule (`❌ Do not mark two slices as parallelizable when they write to the same file(s)`). Extended the vertical-slice-rules in `<supporting-info>` with the parallel-implies-disjoint invariant.

---

## afk/fleet.md — fleet-width-by-disjunction guidance (issue #1336)

- **status**: modified
- **upstream**: —
- **why**: Spec #1333 root cause 1 — operators had no documented guidance on choosing a safe fleet width. Running `fleet 2` on a fully entangled refactor serialized by `req:N` is wasteful at best and risks spurious conflicts if a dependency edge is missing.
- **what changed**: added a "## Fleet Width by Disjunction" section to `plugins/dev/skills/engineering/afk/fleet.md` stating the rule: fleet width = degree of disjunction. Covers the disjoint-queue (full fleet safe), partially-entangled-queue (lower width to disjoint-group count), and fully-entangled-refactor (`fleet 1`) cases. Cross-references `/to-tickets` as the skill responsible for expressing file-level dependencies as `req:N` edges before queue publication.

---

## afk (engineering) — validation-authority guard: the gate command is canonical (issue #1334)

- **status**: modified
- **upstream**: —
- **why**: Spec #1333 root cause 3 — reddb codex workers self-imposed `cargo clippy --all-targets` (the designed gate deliberately runs clippy *without* it), surfaced ~2300 mirage diagnostics, and falsely condemned a green `main`. Nothing in the inner-agent contract said the configured gate is the only definition of green.
- **what changed**: added a binding *Validation Authority* section to `plugins/dev/skills/engineering/afk/AGENT-PROMPT.md` — the gate command is canonical, no stricter flags / extra lints / widened target sets, plus the three-step mirage-reconciliation rule (find the gate's real command → re-run it unmodified → if green, drop the finding) and an explicit ban on reporting a red `main` from a check the gate does not run. Mirrored the rule into the `EXIT_PROTOCOL` system prompt and the `<merge-gate>` body (`apps/dev/src/core/handoff.ts`), and into the Feedback-loops step of `afk/SKILL.md`. Pinned all of it with a new docs-contract test (`apps/dev/tests/afk-validation-authority-docs.test.ts`) plus `handoff.test.ts` assertions.

---

## research (knowledge) - upstream v1.1.0 delta reviewed; no-op (issue #1300)

- **status**: reviewed, no change
- **upstream**: `d574778` (upstream v1.1.0)
- **why**: RedSkills already predates the upstream research delta with a repo-native official-source research workflow and report location.
- **what changed**: nothing - existing `/research` convention remains the adopted RedSkills surface.

---

## to-spec (engineering) - upstream template delta rejected (issue #1300)

- **status**: reviewed, no change
- **upstream**: `d574778` (upstream v1.1.0)
- **why**: RedSkills keeps the richer `Human Decisions` section because Spec children need to distinguish maintainer calls from agent inference.
- **what changed**: nothing - the richer RedSkills template retained by #1293 remains canonical.

---

## teach (upstream) - not carried (issue #1300)

- **status**: skipped
- **upstream**: `d574778` (upstream v1.1.0)
- **why**: RedSkills is an engineering-automation suite and does not carry upstream teaching skills.
- **what changed**: nothing - no `teach` skill is registered.

---

## ask-matt (upstream) - superseded by ask-red (issue #1300)

- **status**: superseded
- **upstream**: `d574778` (upstream v1.1.0 `ask-matt`)
- **why**: The router concept was adopted as `ask-red`, with RedSkills-specific `/afk`, `/go`, HITL, Wayfinder, and doctor-sync routing.
- **what changed**: nothing beyond the #1299 `ask-red` adoption already recorded below.

---

## ask-red (engineering) - RedSkills flow router (issue #1299)

- **status**: renamed-from-ask-matt
- **upstream**: `d574778`
- **why**: Upstream v1.1.0 added a flow router; RedSkills needs the same orientation layer but with `/afk` as the tracked-work default and `/go` as the ad-hoc exception.
- **what changed**: Added the RedSkills router skill, registered it in the dev plugin and public skill maps, documented the maintenance rule, and added the `/doctor` router-coverage sync seam.

---

## triage and setup-red-skills (engineering) - external-PR request surface, default off (issue #1298)

- **status**: modified
- **upstream**: `272f99b` (upstream v1.1.0 external-PR triage surface)
- **why**: Spec #1286 adopts upstream's PR-as-request surface, but RedSkills must keep public PR content behind the ADR 0073 injection boundary and ADR 0085/0086 execution trust gate.
- **what changed**: Added the default-off `dev.triage.external_pr_surface.enabled` config key, documented the setup-template knob under `plugins.dev.triage.external_pr_surface.enabled`, and updated `/triage` so PR discovery is fully inert unless the toggle is explicitly true. When enabled, `/triage` lists only external PRs, treats PR bodies/comments/titles/diffs as untrusted data, generalizes bug reproduction to "verify the claim", runs a redundancy check before polluting out-of-scope knowledge, and forbids checking out, building, installing dependencies for, testing from, or executing PR code.

---

## wayfinder (engineering) - adopted planning on-ramp for RedSkills queue (issue #1297)

- **status**: added
- **upstream**: `272f99b` (upstream `wayfinder`)
- **why**: upstream v1.1.0 adoption now needs a RedSkills-native planning on-ramp for work too large for one agent session, without bypassing the existing GitHub Issue, AFK, HITL, native sub-issue, and `req:N` dependency machinery.
- **what changed**: Added `/wayfinder` as an engineering skill. It creates one `wayfinder:map` Ticket with `## Destination`, `## Not yet specified`, and `## Out of scope`; keeps the map as an index, not a store; publishes one-session child Tickets typed `wayfinder:research`, `wayfinder:grilling`, `wayfinder:prototype`, or `wayfinder:task`; routes AFK-typed children through normal `ready-for-agent` / `blocked:dependency` handling unchanged; routes HITL-typed children to `/start` or `/prototype` sessions via `ready-for-human` and assignment; and preserves the no-fog early exit. Registered the skill in the dev manifest, bucket README, root README, setup label provisioning notes, label vocabulary, and docs-contract test.

---

## doctor (engineering) — native dependency edge divergence guard (issue #1296)

- **status**: modified
- **upstream**: `272f99b`
- **why**: ADR 0094 keeps native blocked-by edges and `req:N` labels deliberately redundant; the doctor needs to surface drift before humans trust one surface while AFK reads the other.
- **what changed**: Added the read-only dependency-edge doctor seam that compares each open Ticket's native blocked-by ids with its `req:N` labels, reports both missing-label and missing-native-edge directions per Ticket, skips parent Specs carrying `type:spec`, renders a compact TOON scorecard, and delegates repair to `/triage` instead of mutating labels or native edges.

## to-tickets and triage (engineering) — native dependency edges alongside req labels (issue #1295)

- **status**: modified
- **upstream**: `272f99b` (where applicable)
- **why**: ADR 0094 adopts upstream v1.1.0's native dependency surface for humans while keeping RedSkills' proven `req:N` label runtime as the machine truth.
- **what changed**: `/to-tickets` now directs publishers to create native sub-issue relationships for parent Spec children and native blocked-by relationships for dependencies while retaining `spec:N`, `blocked:dependency`, one `req:N` label per blocker, and the strict `## Blocked by` body fallback. `/triage` now carries the same both-surfaces directive when it creates or refreshes child/dependency metadata, with an explicit do-not-clean-up warning for the controlled redundancy.

## to-spec (engineering) — renamed from to-prd; vocabulary big bang (issue #1293)

- **status**: renamed-from-to-prd
- **upstream**: `272f99b`
- **why**: upstream v1.1.0 + ADR 0093 adopt the Spec/Ticket vocabulary at total scope — the artifact this skill produces carries implementation and testing decisions, so it is a specification, not a PRD. Atomic big-bang flip, no compatibility window.
- **what changed**: Renamed the skill directory `to-prd/` → `to-spec/` and `name:`/`description` frontmatter (PRD → Spec). Flipped body vocabulary — `type:prd` → `type:spec`, `prd:{N}` → `spec:{N}`, `/to-issues` → `/to-tickets`, PRD → Spec throughout. Retained the RedSkills-only Human Decisions template section and the #1285 cascade gate unchanged.

---

## to-tickets (engineering) — renamed from to-issues; vocabulary big bang + wide-refactor section (issue #1293)

- **status**: renamed-from-to-issues
- **upstream**: `272f99b`
- **why**: upstream v1.1.0 + ADR 0093 — "issue" is tracker-jargon; "Ticket" names the unit of work. Renamed at total vocabulary scope alongside the runtime/label flip.
- **what changed**: Renamed the skill directory `to-issues/` → `to-tickets/`, the `# To Tickets` title, and `name:`/`description` frontmatter. Flipped `type:prd` → `type:spec`, `prd:{N}` → `spec:{N}`, PRD → Spec. Updated the `## Parent` template to emit a literal `Spec #N` line (the pin-reader parses it for branch-pin inheritance). Absorbed the upstream **wide refactors — expand → migrate → contract** reference section for blast-radius-wide mechanical changes, with a big-bang exception note.

---

## setup-red-skills, triage, hitl, requeue, retake, afk, doctor, implement, go, dashboard, adr-editor, urgent, code-review, start, write-a-skill (engineering/productivity) — Spec/Ticket label vocabulary (issue #1293)

- **status**: modified
- **upstream**: `272f99b` (where applicable; RedSkills-original skills: —)
- **why**: ADR 0093 big-bang flip — every skill that seeds, documents, or references the label vocabulary must speak `type:spec`/`spec:N` and the `/to-spec` / `/to-tickets` skill names, with no `type:prd`/`prd:N`/`--prd` survivors outside historical records.
- **what changed**: Flipped `type:prd` → `type:spec`, `prd:N`/`prd:{N}` → `spec:N`/`spec:{N}`, `--prd` → `--spec`, `/to-prd` → `/to-spec`, `/to-issues` → `/to-tickets`, and PRD → Spec across the triage-label vocabulary doc, `/setup-red-skills` seeding prose, and the prose of the listed skills. Historical `(PRD #NNN)` attribution comments left intact. The AFK runtime (`--spec` flag, `spec:` body-line, `spec:N` label + `type:spec` hard filter, cascade-rebase, statusline/dashboard counters), the `LABEL_TYPE_SPEC` constant, pin-reader `Spec #N` parsing, and the existing dev suites were flipped in the same change; Codex manifests regenerated.

---

## prototype (engineering) — model-invoked flip with leading-word description (issue #1291)

- **status**: modified
- **upstream**: —
- **why**: upstream v1.1.0 adoption — /prototype should be reachable by the model (and skills like /wayfinder) autonomously when a design question is open; the previous description led with an imperative verb phrase and bundled all triggers into one clause, making the signal weak for model invocation.
- **what changed**: Rewrote the frontmatter `description` to lead with the skill name ("Prototype") as the leading word, followed by a single-line gloss ("throwaway code that answers one design question"), then a "Use when" clause with one trigger per branch (state/logic → interactive terminal explorer; appearance → multi-variation UI route). No `disable-model-invocation` flag was added or removed (skill was already model-invocable).

---

## write-a-skill (productivity) — adopt Negation + Negative Space steering failure modes (issue #1290)

- **status**: modified
- **upstream**: —
- **why**: upstream v1.1.0 adoption — the skill taught nine sentence-level techniques and a review checklist but had no named failure modes for the Steering dimension; Negation and Negative Space are the two recurring patterns that survive the writing phase yet undermine the skill at inference time.
- **what changed**: Added a new `## Steering failure modes` section between the writing-style techniques and the review checklist, with two named entries — **Negation** (prohibition amplifies the forbidden behaviour; cure: positive directive + paired alternative) and **Negative Space** (silence is delegated to priors; cure: deliberate fill-or-branch for every omission). Added two matching review-checklist items: `Negation check` and `Negative-space audit`.

---

## afk (engineering) — remove auto-monitor loop (issue #1309)

- **status**: modified
- **upstream**: —
- **why**: the auto-monitor loop (CronCreate/CronList wiring) added complexity and noise; the manual `/afk monitor` dashboard and the Codex monitor agent are sufficient.
- **what changed**: deleted `apps/dev/src/core/auto-monitor.ts` and `apps/dev/tests/auto-monitor.test.ts`; removed the `--reactive-check` handler and its helper functions (`reactiveWorkerAlert`, `reactiveFleetAlert`, `renderReactiveCheck`) from `apps/dev/src/commands/monitor.ts`; deleted the "Auto-Monitor Loop" section from `plugins/dev/skills/engineering/afk/SKILL.md`; removed auto-loop references from `fleet.md`, `monitor.md`.

## relabel-sweep (internal/maintainer)

- **status**: added
- **upstream**: none
- **why**: issue #1292 (Spec #1286, ADR 0093) — the big-bang Spec/Ticket vocabulary flip needs a one-shot sweep to migrate open Tickets' historical label families to the new vocabulary; closed Tickets keep their labels (history is not rewritten).
- **what changed**: added the `dev relabel-sweep` runtime command (`apps/dev/src/commands/relabel-sweep.ts`) plus its pure planner (`apps/dev/src/core/relabel-sweep.ts`). It migrates OPEN Tickets' labels `type:prd → type:spec` and `prd:N → spec:N`, creating the missing target labels on demand, and leaves `req:*` and every other family untouched. `--dry-run` prints the complete per-Ticket plan and writes nothing; the real run applies exactly that plan and is idempotent (a replay finds no old-vocabulary labels and no-ops). The tool ships inert — executing the real sweep against the repo is a separate operator Ticket. Unit-tested planner + injected-gh command control flow; wired into the CLI router.

## create-plugin (internal/maintainer)

- **status**: added
- **upstream**: none
- **why**: issue #1196 - new repository plugins should be born compliant with the RedSkills marketplace contract instead of being retrofitted after creation.
- **what changed**: added the internal `create-plugin` maintainer skill and scaffolder. Generated plugins include Claude and Codex manifests, a two-section seed SKILL.md, README, CHANGES stub, structural smoke script, root README entry, and entries in both marketplace manifests. Added an acceptance test that scaffolds a fixture plugin and runs marketplace validation, skill frontmatter audit, and the generated smoke script with zero manual edits.

## tdd (engineering) — reference-only reshape + tautological-test anti-pattern (issue #1289)

- **status**: modified
- **upstream**: `272f99b` (upstream `tdd`)
- **why**: upstream v1.1.0 adoption — the rigid step workflow (Steps 1–3 requiring user approval gates) prevents AFK agents from consuming the skill directly; dropped the steps, kept the loop rules. Added the tautological-test anti-pattern as a peer of the implementation-coupling one: a test whose assertion is recomputed the way the code computes it passes by construction and proves nothing.
- **what changed**: removed Steps 1–3 from `<what-to-do>` and replaced them with a seam declaration and the loop rule ("red before green, one slice at a time, tests only at pre-agreed seams"). Added a sixth per-cycle checklist gate ("Expected values come from a literal, worked example, or spec — not recomputed the way the code computes them"). Added "Tautological tests" as a named second bad-test pattern in the Philosophy section of `<supporting-info>`, parallel to the existing "Implementation-coupled tests" entry. Added a BAD/GOOD example pair in `tests.md`. Added `tdd-docs.test.ts` pinning the reference-only shape and all three tautological-test sites.

## start (engineering) — facts-vs-decisions distinction in hard rules (issue #1288)

- **status**: modified
- **upstream**: `272f99b` (upstream `grilling`)
- **why**: upstream v1.1.0 grilling fix — the old "explore instead of asking" rule could be read as license for the agent to answer decisions autonomously (self-grilling failure mode, especially with Fable). Facts can be looked up; decisions belong to the human.
- **what changed**: replaced the blanket "explore when a question can be answered by reading code instead of asking" rule with three targeted rules: a ❌ prohibition on answering decisions yourself ("broken the interview"), a ✅ rule to look up facts in the codebase, and a ✅ rule to put every decision to the human and wait. Updated the docs-contract test to pin the three new load-bearing phrases.

## to-prd (engineering) — cascade gate before publish (issue #1285)

- **status**: modified
- **upstream**: `aaf2453` (upstream `to-prd`)
- **why**: PRD #1283 — AFK workers branch from `origin/{base}` and cannot see primary-checkout working-tree edits; the cascade gate prevents publishing a PRD while the `.red/` docs it references are unlanded.
- **what changed**: Added a new Step 3 "Cascade gate" before the publish step: `git fetch origin`, compare `.red/` docs between working tree and `origin/{base}` (origin-first comparison), run the `/start` end-of-session doc-landing procedure (ADR 0092) on mismatch, or abort loudly if landing is impossible. Old Step 3 (write + publish) renumbered to Step 4.

## to-issues (engineering) — cascade gate before publish (issue #1285)

- **status**: modified
- **upstream**: `e74f006` (upstream `to-issues`)
- **why**: PRD #1283 — same invariant as `/to-prd`: AFK workers cannot see unlanded docs; the gate must run before any issues enter `ready-for-agent`.
- **what changed**: Added a new Step 5 "Cascade gate" between the quiz step and the publish step: identical origin-first comparison and doc-landing-procedure reference (ADR 0092), with loud abort when landing is impossible. Old Step 5 (publish) renumbered to Step 6. Added `cascade-gate-docs.test.ts` pinning the load-bearing gate phrases in both skills.

## start (engineering) — land grill-session docs before cascade (issue #1284)

- **status**: modified
- **upstream**: `272f99b` (upstream `grilling`)
- **why**: PRD #1283 — `/start` mutates glossary/ADR docs inline, and downstream `/to-prd`, `/to-issues`, and `/afk` work must read the same origin-visible docs truth instead of session-local primary-checkout edits.
- **what changed**: Added the end-of-session doc-landing finalizer directive to `/start`: detect dirty `.red/CONTEXT.md`, `.red/CONTEXT-MAP.md`, `.red/contexts/**`, and `.red/adr/**` files; announce file list and ADR numbers with a decline path; land one batch docs PR through an isolated `.red/tmp/` worktree from freshly fetched `origin/{base}` (base resolved lock > pin > main); and restate the primary-checkout prohibitions against commit, branch switch, stash, and reset. Added ADR 0092 for the finalizer + follow-up cascade-gate decision and a docs-contract test pinning the load-bearing phrases.

## audit-skills (engineering)

- **status**: added
- **upstream**: —
- **why**: original to reddb.io — a read-only skill-quality auditor that scores every shipped SKILL.md against the house style (issue #1167).
- **what changed**: new user-invoked `dev audit-skills` subcommand + `disable-model-invocation: true` skill. Mechanical sub-score ports the report-only lint (description budget + 1024-char hard cap, literal "Use when", `<what-to-do>` on long bodies, bold first line, `name:` presence, English-only, orphaned bundled files); semantic sub-score is an LLM judge on the dev review engine (sandcastle structured output, injection-guarded) scoring the nine write-a-skill techniques + trigger clarity + deletion-test bloat + section placement. Ranks worst-first with a best-effort memory-telemetry overlay; scorecard-only, zero side effects. Also aligned CLAUDE.md's "eight techniques" to nine (added "leading words").

## craft/productivity/misc skills — pruning sweep B: no-op deletion, house tags, single-home rules (issue #1148)

- **status**: modified
- **upstream**: code-review `21f5976`; migrate-to-shoehorn `e74f006`; context, improve-codebase-architecture, implement, model-tier-policy, ff, writing-shape, writing-beats `—`
- **why**: PRD #1132 — pruning sweep over the explicit craft/productivity/misc targets the audit flagged: delete no-op provenance, collapse rules the skills state twice to one authoritative home, add the house `<what-to-do>`/`<supporting-info>` split where missing, and resolve orphaned/duplicated bundled content.
- **what changed**:
  - **context**: deleted the "Source inspirations folded into RedSkills" section (a no-op — its removal changes no agent behavior); removed the token-efficient-terminal (RTK) phase (step 7) plus its report-posture bullet and hard rule (orthogonal to context-building, duplicates repo-level RTK guidance); renumbered the remaining phases.
  - **code-review**: wrapped the process in `<what-to-do>` and moved the "Why two axes" rationale into `<supporting-info>`; the twelve Fowler smells now live only in the supporting-info table — the Standards sub-agent prompt references the table (pasted in verbatim by the caller) instead of re-enumerating the smells.
  - **improve-codebase-architecture**: added the house tag split (Glossary → `<supporting-info>`, Process → `<what-to-do>`); linked the previously loose `DEEPENING.md` directly from the grilling loop (its content is live — reachable via `INTERFACE-DESIGN.md`) so no bundled file is orphaned.
  - **implement**: the `/implement`-vs-`/afk` distinction is now stated once (the `<what-to-do>` table); deleted the duplicate "When to use `/implement` vs `/afk`" bulleted list from `<supporting-info>`.
  - **migrate-to-shoehorn**: merged the two overlapping `fromPartial` example blocks into one; dropped the `fromExact()` row from the summary table (it had no explanation or example anywhere).
  - **writing-shape**: moved the executable 5-step loop from `<supporting-info>` into `<what-to-do>` (matching the sibling `writing-beats`); deduped the name-the-gap-or-cut rule — the out-of-scope bullet now references the "Pulling from the pile" home instead of restating it.
  - **writing-beats**: trimmed the "Writing one beat" subsection that restated journey step 2, keeping only its unique pile-quarry guidance under a "Pulling from the pile" heading.
  - **model-tier-policy**: collapsed the "never copy this table into executor prompts; point executors here" rule to the single bold-lead statement (removed the near-verbatim restatement); dropped the "Spike finding for #457" residue note in the Codex-interactive section (kept the ADR 0049 pointer).
  - **ff**: the worked example now references the Step 1 framing menu instead of reprinting it (menu printed once); deleted the "Why two steps" rationale section (deletion test: behavior unchanged).

## queue/tracker skills (engineering) — pruning sweep A: collapse repeated rules to single authoritative statements (issue #1147)

- **status**: modified
- **upstream**: to-issues `e74f006`; to-prd `aaf2453`; setup-red-skills, report-bug, requeue, urgent, retake, hitl `—`
- **why**: PRD #1132 — the queue/tracker skills the audit rated healthy still repeated the same rule three-to-five times each; the fix keeps exactly one authoritative statement per rule (preferring the supporting-info home) so steps reference detail instead of restating it.
- **what changed**:
  - **setup-red-skills**: kept the sole-`.red/`-creator rule as the description mention + one body statement (dropped two body restatements); collapsed the three-prefix workflow-naming convention to one sentence + the `WORKFLOWS.md` pointer (removed two full restatements); replaced the per-substep no-clobber repetition with a single **No-clobber rule** hard statement at the top of the Write step plus brief per-step reminders and the two flagged surgical exceptions; deleted the retired-`/ship` sediment line.
  - **to-issues**: made the Hard-rules bullet the single authoritative statement of the `req:N`-must-not-target-a-PRD rule (with the #907/#928 incident citation); Step 5 now references it.
  - **to-prd**: fixed the doubled "no interview" sentence in the header; wrapped the process steps in `<what-to-do>` and the PRD template in `<supporting-info>` (house tag split, matching siblings).
  - **report-bug**: trimmed the title-rule, label-rule, and route-to-`/triage` step mentions to one-line references pointing at their dedicated supporting-info sections.
  - **requeue**: adopted the house tag split; printed the two run commands once (removed the duplicate Run block); collapsed the `/ship`-retired notice to one mention (the `/dev:ship` See-also entry); kept the `/requeue`-vs-`/hitl` boundary table as the single home.
  - **urgent**: kept the `gh label create priority:urgent` command once (the supporting-info Labels section, now carrying the full command); shrank the title/label restatements in the Filing steps to references.
  - **retake**: collapsed the doubled `--apply` safety caveat to one enumeration.
  - **hitl**: added the missing `<supporting-info>` half; moved the `/requeue` comparison (now pointing at requeue's boundary table) and the Directive-block template into it; collapsed the delegable-manual-landing routing to one explanation (Step 4) + one pointer (Step 6).

## doctor (engineering) — move `--fix` Apply table behind a branch-gated pointer, trim MCP-wiring archaeology (issue #1145)

- **status**: modified
- **upstream**: —
- **why**: PRD #1132 — the ~18-row Apply table plus most of the Fix pass are used **only** when `--fix` is passed, yet the default read-only diagnose pass (the common path) paid for them inline; the MCP-wiring check also carried cancelled-migration history the current rule does not need.
- **what changed**: Moved the whole Apply table (finding → `--fix` action + gate) into a bundled sibling `APPLY.md`, behind a one-line "running with `--fix` → read `APPLY.md`" pointer at the Fix pass (Pass 2). The findings→owner mapping now lives in exactly one home — the inline *Fix-home* table — while `APPLY.md` layers action+gate on top of it. Trimmed the MCP-wiring check's (check 8) reversed-amendment / archived-repo history to a single parenthetical sentence, keeping the current finding rule intact. The read-only diagnose pass now contains no `--fix` Apply detail.

## setup-statusline (engineering) — move per-host rationale behind pointers, de-dup the bundle-resolution command (issue #1145)

- **status**: modified
- **upstream**: —
- **why**: PRD #1132 — three host branches each carried deep rationale inline that only that branch needs, the long `sh -c` bundle-resolution command was duplicated verbatim across the install and verify steps, and the skill lacked the setup-wizard `disable-model-invocation: true` flag.
- **what changed**: Moved the Claude-only "why this shape, not the plugin-root variable" + "why the cached bundle, not the runtime script" blocks and the Codex-only "surviving config resets" block into a bundled `HOST-NOTES.md`, behind per-branch one-line pointers. Factored the `sh -c` command so it appears exactly once (the verify step now references the install step's command instead of re-inlining it). Shrank the OpenCode nothing-to-install section to one line and added `disable-model-invocation: true` to the frontmatter. The installed statusLine command is byte-identical (verified) — prose moved, command untouched, still cached-bundle-first per ADR 0084.

## wiki (knowledge) — extract single-branch C4 section behind pointers, adopt house tags (issue #1144)

- **status**: modified
- **upstream**: —
- **why**: PRD #1132 — at 263 lines `wiki` was the repo's second-largest skill, with its ~115-line C4 Diagram section (44% of the file) reachable from only two narrow paths, and it lacked the `<what-to-do>`/`<supporting-info>` house split the size makes acute.
- **what changed**: Moved the entire C4 Diagram body into a bundled sibling `C4-reference.md` (following the existing `REFERENCES.md` pattern). Left exactly two one-line context pointers — the Ingest C4-awareness step and the Lint C4-staleness check — that own the *when* and link the reference for the *how*. Deduped inside the extracted content: the vocabulary-discipline rule now appears once, and the "When to create"/"When to update" trigger subsections were dropped (their conditions already live at the two pointer sites). Wrapped the verb procedures (Preconditions, Routing, Ingest, Query, Lint) in `<what-to-do>` and the Anti-patterns + References in `<supporting-info>`. SKILL.md dropped from 263 to ~154 lines; verb behavior, wiki schema contract, and `wiki-init` templates unchanged.

## daily-review (engineering) — merge weekly-review into one period-parameterized skill, shared wrapper, house tags, disable-model-invocation (issue #1142)

- **status**: modified
- **upstream**: —
- **why**: PRD #1132 — `daily-review` and `weekly-review` were ~90% identical; the pair was a maintenance liability and `weekly-review` was missing the TOON output-format section. Consolidating into one period-parameterized skill removes the duplicate and closes the parity gap.
- **what changed**: Merged `weekly-review` into `daily-review` with `--period day` (default) and `--period week` flag. Extracted the common Run shim and TOON output paragraph into `_report-runtime/WRAPPER.md`, consumed by both `daily-review` and `dashboard`. Applied `<what-to-do>`/`<supporting-info>` house-tag split to `daily-review` and `dashboard`. Added `disable-model-invocation: true` to both skills. Removed `weekly-review/` directory and its manifest entry. Updated bucket README, root README skill map, and claude-plugin manifest.

## weekly-review (engineering) — removed, merged into daily-review (issue #1142)

- **status**: removed
- **upstream**: —
- **why**: Subsumed by the period-parameterized `daily-review` skill; `--period week` covers the six-day window. See `daily-review` entry above.
- **what changed**: Directory and manifest entry deleted.

---

## afk (engineering) — slim SKILL.md: extract monitor + fleet, collapse mantras, English-only (issue #1140)

- **status**: modified
- **upstream**: —
- **why**: PRD #1132 — `afk/SKILL.md` was the largest skill in the repo (673 lines). Two single-branch sections (Monitor + Task Mirror + Codex monitor agent; Fleet Mode) and several repeated mantras inflated the always-loaded contract without adding reachable behaviour.
- **what changed**: Extracted the Monitor / Task-Mirror / Self-Cancel / Codex-monitor-agent material into a sibling [`monitor.md`](plugins/dev/skills/engineering/afk/monitor.md) and the Fleet-Mode section into [`fleet.md`](plugins/dev/skills/engineering/afk/fleet.md), leaving one-line pointers at the `afk monitor` / `afk fleet` branch points (the proven `actions-lane.md` pattern). Collapsed the "mirror is binding / re-check every tick" rule (previously stated three times) into one authoritative statement in `monitor.md`. Collapsed the "run the bundle, don't read the source" mantra from four occurrences to one (the intro). Deleted the duplicate CLI-flag enumeration (the *When To Use* section stays authoritative). Replaced two committed Portuguese phrases ("issue perdida", the promise-result quote) and the `"como estamos?"` aside with English. Deleted the "legacy shell orchestrator removed" sediment note. SKILL.md 673 → 429 lines; no orchestration behaviour, command, or flag semantics changed — content moved, not deleted.

## tdd (engineering) — repoint review routing to `/code-review`, drop orphaned refactoring.md (issue #1137)

- **status**: modified
- **upstream**: `21f5976`
- **why**: PRD #1132 — a name-collision bug: the closing line routed cleanup to `/review`, but `/review` is now the HTML-artifact annotation skill; the diff/cleanup reviewer is `/code-review`. The reference predated the `review` skill's repurposing. The bundled `refactoring.md` was left orphaned — nothing in SKILL.md linked it, and its refactor-candidates checklist is covered by `/code-review`'s cleanup mandate.
- **what changed**:
  - Closing line: "run `/review` on the branch to clean up" → "run `/code-review` on the branch to clean up".
  - Deleted `refactoring.md` (orphaned; content covered by `/code-review`).

## git-guardrails-claude-code (misc) — reconcile with ADR 0083, prune, user-only flip (issue #1138)

- **status**: modified
- **upstream**: —
- **why**: PRD #1132 — this skill contradicted `branch-lock` on `dev.lock.primary-branch`: it presented the key as the guard's enabler and claimed "missing file/key means off", while ADR 0083 §2 makes the primary-branch guard fire unconditionally under `plugins.dev.enabled: true`. It also duplicated `branch-lock`'s docs and interleaved steps with reference.
- **what changed**: Rewrote the primary-branch-guard section to the unconditional ADR 0083 semantics; removed the "missing key means off" claim; the legacy `dev.lock.primary-branch` key is now described as read-only history in one line. Shrank the branch-lock-awareness block to a one-line pointer at `branch-lock`. Collapsed the near-identical project/global JSON hook blocks to one block with the path delta described in a sentence. Added the house `<what-to-do>`/`<supporting-info>` split. Added `disable-model-invocation: true` (setup wizard, deliberately fired; the guard runs via hooks, not skill invocation). Prose-only — no hook/script behavior touched.

## branch-lock (misc) — prune to `<what-to-do>` first, dedup block-vs-allow, user-only flip (issue #1138)

- **status**: modified
- **upstream**: —
- **why**: PRD #1132 — heaviest skill in the misc bucket (206 lines) with a ~46-line reference preamble before `<what-to-do>` and block-vs-allow behaviour stated three times.
- **what changed**: Moved the reference preamble (guard rationale, ADR 0083 background, work-loss family, enforcement notes) into `<supporting-info>` so no reference material precedes `<what-to-do>`. Collapsed block-vs-allow to a single authoritative section (removed the preamble enumeration and the later restatement). Compressed the deprecated-key YAML example to one line. Deleted the "Scope of this slice" / PRD-status block. Added `disable-model-invocation: true` (lock-management command, deliberately fired; the guard runs via hooks). Prose-only — no hook/script behavior touched.

## ship (engineering) — shrunk to a user-only redirect stub (issue #1136)

- **status**: modified
- **upstream**: —
- **why**: PRD #1132 trigger-wave — `ship` is retired (ADR 0081); a deprecation alias must cost nothing and teach nothing beyond where to go instead.
- **what changed**: Cut from ~74 to 20 lines. Added `disable-model-invocation: true` so the dead alias is neither model-reachable nor pays description context. Deleted the seven-stage pipeline and mechanical-vs-intentional fix-split sections (they document the shared gate's internals and cite source symbols — that content lives with `/requeue` and ADRs 0055/0071). Kept the `/requeue` (and `/go`) redirect and the backwards-compat alias note.

## setup-pre-commit (misc) — user-only flip: disable-model-invocation (issue #1134)

- **status**: modified
- **upstream**: `e74f006`
- **why**: PRD #1132 trigger-wave — `setup-pre-commit` is an operational command always fired explicitly by the user; flipping removes its description from session context.
- **what changed**: Added `disable-model-invocation: true` to frontmatter.

## handoff (productivity) — user-only flip: disable-model-invocation (issue #1134)

- **status**: modified
- **upstream**: `b8be62f`
- **why**: PRD #1132 trigger-wave — `handoff` is an operational command always fired explicitly by the user; flipping removes its description from session context.
- **what changed**: Added `disable-model-invocation: true` to frontmatter.

## write-a-skill (productivity) — absorb the four-dimension skill-quality checklist (issue #1133)

- **status**: modified
- **upstream**: —
- **why**: PRD #1132 (Matt Pocock skill-quality checklist). The meta-skill taught the eight sentence-level techniques and the `<what-to-do>`/`<supporting-info>` split, but not the four skill-quality dimensions (trigger / structure / steering / pruning). It also shipped an embedded template that contradicted the house convention it enforces.
- **what changed**: All additive. Added a **Trigger decision** section (user-invoked vs model-invoked, `disable-model-invocation: true`, the context-load vs cognitive-load trade-off, the deliberate-command ⇒ user-only default rule, and the unpredictability cost of model invocation). Extended **When to split files** with the branch-gated external-reference rule (`if X, read Y`) naming `afk`'s `actions-lane.md`, `tdd`'s bundled reference files, and `prototype`'s `LOGIC.md`/`UI.md`. Added a **Leg-work splitting** section citing `/start` → `/to-prd` and `writing-fragments` vs `writing-shape`/`writing-beats`. Added a ninth writing-style technique, **leading words**, with a before → after pair. Added two review-checklist items (deletion test; trigger decision recorded). Replaced the embedded SKILL.md template's `## Quick start / ## Workflows / ## Advanced features` layout with a `<what-to-do>` / `<supporting-info>` template so the meta-skill dogfoods the convention. Docs-only — no runtime/bundle/hook change.

## triage (engineering) — injection-guard note for untrusted issue content (issue #1110)

- **status**: modified
- **upstream**: —
- **why**: Issue bodies and comments are attacker-controlled input in public workflows; triage must treat them as evidence, not commands that can self-promote an issue to `ready-for-agent` or `priority:urgent`.
- **what changed**: Added an explicit injection-guard hard rule to `/triage`: issue bodies/comments are data, not instructions, and cannot drive labels, dependency edges, closure, or agentability without maintainer direction through the triage flow.

---

## tdd + start (engineering) — upstream drift review 21f5976..272f99b: nothing adopted

- **status**: reviewed, no change
- **upstream**: `272f99b`
- **why**: Reviewed the two Matt-derived skills touched in `21f5976..272f99b`. Neither upstream tweak survived the adoption bar.
- **what changed**:
  - `tdd`: upstream renamed the cross-reference from `'review' skill` to `'code-review' skill`. Our version (`plugins/dev/skills/engineering/tdd/SKILL.md`) is heavily diverged and ships both a `/review` and a `/code-review` skill — the right pointer is ambiguous without deeper reading. Conservative bias: skipped.
  - `start` (maps to upstream `grilling`): upstream added "Do not enact the plan until I confirm we have reached a shared understanding." and changed the frontmatter description. Our `/start` skill already enforces both constraints more explicitly (`shared understanding is the only exit condition`; hard rules banning implementation and artefacts). Nothing new to add.

---

## to-issues + triage + doctor (engineering) — forbid `req:<PRD>` dependency edges (issue #1048)

- **status**: modified
- **upstream**: —
- **why**: A `req:N` edge pointing at a PRD couples slice throughput to a manual bookkeeping step — a PRD closes long after its substance ships (#907/#928: 46/46 children closed, PRDs still open), so the dependent strands in `blocked:dependency` forever. This was the structural half of the 2026-07-02 queue freeze (14 slices carried `req:907`/`req:928` and could never promote).
- **what changed**:
  - `to-issues`: `req:N` publish step + hard rule now require the author to verify the target is not `type:prd` and re-point at the PRD's executable `prd:N` slices (or a named slice created for the dependent).
  - `triage`: same validation added as a hard rule before any `req:N` label is applied.
  - `doctor`: new read-only check 13 — `req:<PRD>` dependency-edge audit, one warn line per offending edge, delegated to `/triage`; added Fix-home + Apply rows and description entry.
  - `.red/agents/triage-labels.md` *Dependency Edges*: documents the rule "`req:` targets must be executable issues, never `type:prd`" with the #907/#928 incident as rationale.

---

## branch-lock (misc) — primary-checkout branch guard is now unconditional (#1025)

- **status**: modified
- **upstream**: —
- **why**: ADR 0083 §2 (untouchable primary) makes "may an agent switch the primary checkout's branch" non-configurable — the answer is always no. The guard previously armed only with `dev.lock.primary-branch: true` (or a lock file); that toggle is removed.
- **what changed**:
  - `branch-lock-hook.sh` / `branch-lock-codex.sh`: the primary-branch-switch block no longer gates on `dev_config_lock_primary_branch_enabled`. Once `plugins.dev.enabled: true`, any agent `git switch`/`git checkout`/`git switch -b` of the primary is blocked with no lock and no config toggle.
  - Refusal message now references the untouchable-primary rule (ADR 0083) instead of naming the config flag.
  - The `dev.lock.primary-branch` key stays readable (`dev-config.sh` unchanged) for backward compatibility but can no longer enable/disable switching; `/doctor` may note it as redundant.
  - Merged with #1024's guard extensions: the reset/stash/autostash family rides the same shared classifier and is therefore also blocked unconditionally in the primary checkout. The lock-file-gated semantics (AFK base/merge-target read, whole-tree restore under an active lock) are untouched. Human terminals stay unaffected (ADR 0006).
  - Updated `SKILL.md` and the Claude/Codex plugin-hook + CLI shell tests to the unconditional semantics.

---

## afk (engineering) — empty-queue gate census is binding on the invoking agent

- **status**: modified
- **upstream**: —
- **why**: `ready-for-agent: 0` with a gated backlog was reported as "nothing to do"; on 2026-07-02 two fully-delivered-but-open PRDs froze 14 slices unnoticed.
- **what changed**: Issue Selection and Stop Conditions now require a one-line gate census (counts per gate + highest-leverage unblock) whenever the queue is empty but open non-PRD issues exist.

## to-issues (engineering) — `req:N` must target executable issues, never PRDs

- **status**: modified
- **upstream**: —
- **why**: the unblock cascade fires on close; PRDs close on manual bookkeeping, so a `req:<PRD>` edge strands dependents indefinitely (2026-07-02 freeze).
- **what changed**: new hard rule under slice publication; runtime enforcement tracked in #1048.

## hitl (engineering) — delegable-manual-landing disposition

- **status**: modified
- **upstream**: —
- **why**: the binary delegable/non-delegable forced agent-codable manual-merge slices (PRD #1013 T1) to sit as plain human-parked work.
- **what changed**: third disposition (keep `ready-for-human`, dispatch coding via `/go`, human merges; `landing:manual` routing once #1049 lands) in Step 4, Step 6, and the Directive template.

## upstream drift review — 6eeb81b → 21f5976 (issue #896)

- **status**: reviewed
- **upstream**: `21f5976`
- **why**: Periodic upstream drift absorption — 50 commits since last pin. Absorbed TDD improvements and promoted the two-axis code-review skill; skipped decision-mapping, ask-matt, and link-skills (not applicable to red-skills structure).
- **what changed**: See entries below for individual skill changes.

---

## code-review (engineering) — promoted from in-progress + Fowler smell baseline (upstream 21f5976)

- **status**: added
- **upstream**: `21f5976`
- **why**: Upstream renamed `review` → `code-review`. Our `in-progress/review` was already the two-axis review derived from upstream. The rename resolves the naming collision with our own HTML annotation `review` skill. Added the Fowler smell baseline (12 smells, always-on in the Standards axis) which upstream added to their version.
- **what changed**:
  - `plugins/dev/skills/engineering/code-review/SKILL.md`: new file, promoted from `in-progress/review/SKILL.md`; added Fowler smell baseline table to step 3 and Standards sub-agent brief; frontmatter updated to `name: code-review`.
  - `plugins/dev/skills/in-progress/review/SKILL.md`: removed (skill is now promoted to `engineering/code-review`).
  - `plugins/dev/.claude-plugin/plugin.json`: added `./skills/engineering/code-review` entry.
  - `plugins/dev/skills/engineering/README.md`: added `code-review` entry.
  - `README.md`: added `code-review` to the skill map table.

---

## tdd (engineering) — seams concept + tautological anti-pattern + refactor removal (upstream 21f5976)

- **status**: modified
- **upstream**: `21f5976`
- **why**: Three improvements from upstream absorbed: (1) "seams" as the canonical name for the public boundary being tested — upgrades Step 1 from a generic interface question to an explicit seam-confirmation gate; (2) tautological assertion anti-pattern — expected values must come from an independent source of truth, not re-derived the same way the code does; (3) refactoring removed from the TDD loop — upstream explicitly placed it in the review stage, and we align (Step 4 removed; `/review` handles cleanup).
- **what changed**:
  - Frontmatter description: "red-green-refactor loop" → "red → green loop".
  - `<what-to-do>` lead line: removed "then refactor".
  - Step 1 item 3: "public interface" question upgraded to explicit seam-naming and user-confirmation gate.
  - Step 4 — Refactor: removed entirely.
  - Hard rules: removed "❌ Do not refactor while RED" (redundant without Step 4); added "❌ Do not write tautological assertions".
  - Added "✅ Do confirm seams with the user before the first test" to hard rules.
  - Added closing line: "Once all tests are GREEN, refactoring is a separate concern — run `/review` on the branch to clean up."
  - `<supporting-info>`: added "## Seams" section defining the term.

---

## browser-review (in-progress) — CLI↔browser collaboration surface (issue #916)

- **status**: added
- **upstream**: —
- **why**: PRD #928 browser-collaboration capability — replace "screenshot + describe in prose" with surgical human annotation on a generated HTML artifact, and stop an agent declaring a broken render "done".
- **what changed**: new `@reddb-io/browser-bridge` package (`packages/browser-bridge`) — a local, no-cloud annotation bridge (open artifact → inject portable SDK → long-poll for element + character-range annotations) plus a layout-audit gate (`assertLayoutClean`) flagging horizontal overflow / clipped text / overlapping text; new draft skill `plugins/dev/skills/in-progress/browser-review`. No source-repo names in committed content. Artifact-annotation half only; the live-app CDP driver half is a later slice.

---

## ground-truth (engineering) — Adversarial verification ground-truth, snapshot-before-claiming-success (issue #915)

- **status**: added
- **upstream**: —
- **why**: Absorbs the transferable discipline behind `chrome-devtools-axi` per the maintainer steer on #915 — the value is **adversarial / self-verification**, not browser automation per se. A verifier must check its claim against a fresh snapshot / ground-truth read before reporting success (chrome-devtools-axi's "verify state-checking actions with a fresh snapshot" + a11y-tree + stale-ref validation). The browser is the vehicle; the **claim → fresh-ground-truth → confirm** loop is the absorbed idea, applied as the evidence standard for `/verify`, `/code-review`, and the frontend skills.
- **what changed**:
  - added `plugins/dev/skills/engineering/ground-truth/SKILL.md`: the `claim → fresh ground-truth → confirm` loop, stale-ref validation anti-hallucination guard, integration hooks into `/verify` / `/code-review` / frontend skills, the chrome-devtools-axi browser vehicle (a11y-tree numbered refs, combined navigate+capture+suggest, persistent bridge, ~57%-cheaper TOON output), and a table generalizing the loop to DB/file/API/test/review ground truths
  - registered in `plugins/dev/.claude-plugin/plugin.json` (the `.codex-plugin/plugin.json` picks it up via its `./skills/engineering/` wildcard)
  - listed in the root `README.md` table and the `engineering/README.md` bucket index

---

## review (engineering) — HTML artifact review via annotation bridge (issue #943)

- **status**: added
- **upstream**: —
- **why**: Replaces the lossy "screenshot + describe in prose" loop for generated HTML artifacts (plans, dashboards, prototypes). Wires `red-browser` as the first real consumer: serves the artifact locally, runs the layout-audit gate, and long-polls for surgical human annotations (element + character range) that the agent uses to correct and iterate.
- **what changed**:
  - `plugins/dev/skills/engineering/review/SKILL.md`: the `/review` skill — invokes `red-browser annotate`, documents the layout-audit gate contract, annotation interpretation, and iteration loop.
  - `plugins/dev/.claude-plugin/plugin.json`: added `./skills/engineering/review` entry.
  - `plugins/dev/skills/engineering/README.md`: added `review` entry to the bucket listing.
  - `README.md`: added `review` to the "Dev operations and understanding" row of the skill map.

---

## go (engineering) — `/go` dispatch: disposable issue, isolated lane, dedicated namespaced worker (issue #938)

- **status**: added
- **upstream**: —
- **why**: ADR 0081 / PRD #928 defines a semi-structured middle tier between `/goal` (unstructured directive) and `/afk` (structured backlog). `/go "<demand>"` is the front door for one concrete demand → one clean PR, without authoring a PRD or triaging issues.
- **what changed**:
  - `plugins/dev/skills/engineering/go/SKILL.md`: the `/go` skill — invokes the dev bundle's `go` command, documents the isolated `lane:go` lane, the `go-workers/` namespace, `origin=go`, and the interactive gate sink.
  - `apps/dev/src/core/go.ts`: pure dispatch planner — `buildDisposableIssue` (labels `lane:go`, never `ready-for-agent`), `goWorkersRoot`, `buildGoEngineArgs` (reuses the engine `--once --issues N --origin go --lane lane:go`), `dispatchGo` (IO injected).
  - `apps/dev/src/commands/go.ts` + `cli.ts`: the `go` command — mints the disposable issue via `gh`, sets `RED_AFK_WORKERS_NAMESPACE=go-workers`, and runs the reused engine in-process.
  - `apps/dev/src/core/worker-paths.ts`: `workersSegment()` honours `RED_AFK_WORKERS_NAMESPACE` so the `/go` worker dir + worktree land under `.red/tmp/go-workers/`, never colliding with the fleet's `.red/tmp/workers/`.
  - `apps/dev/src/runtime/gh.ts`: `createIssue` helper + `listCandidates(label)` lane override.
  - `apps/dev/src/core/triage-labels.ts`: `LABEL_GO_LANE = "lane:go"`.

---

## hitl-card (engineering) — Actionable decision cards for ready-for-human (issue #927)

- **status**: added
- **upstream**: —
- **why**: `ready-for-human` issues previously required the human to act by hand (reading, labelling, posting comments manually). Issue #927 turns them into IssueOps decision cards: a bot comment renders the pending decision + PR status + slash-command menu, and a GitHub Action executes the ticked command.
- **what changed**:
  - `apps/dev/src/core/hitl-card.ts`: pure logic — `renderCard`, `updateCardStatus` (idempotent status refresh), `isHitlCard` (card detection), `parseCardCommand` (injection-safe first-line slash-command parser), `classifyNaturalLanguage` (keyword-based NL → action mapping), `parseCiChecks`.
  - `apps/dev/src/commands/hitl-card.ts`: IO command handler for `dev hitl-card render | refresh | act` — posts/updates the card, trust-gates `act` via the existing `resolveActorTrust`, executes approve/approve-ci/reject/requeue and posts directive comments.
  - `apps/dev/src/cli.ts`: registers `hitl-card` in the CLI router.
  - `.github/workflows/red-hitl-card.yml`: three-job workflow — `render` on `issues.labeled=ready-for-human`, `act` on `issue_comment.created`, `refresh` on `pull_request.synchronize/reopened/closed`.
  - `apps/dev/tests/hitl-card.test.ts`: 37 unit tests covering all pure functions.

---

## afk (engineering) — Task mirror host capability matrix codified (issue #886)

- **status**: modified
- **upstream**: —
- **why**: The Task mirror's per-host support (Claude Code native task API, Codex monitor-agent fallback, OpenCode headless) was implicit and scattered across ADR 0003/0015 and the runner docs; OpenCode had no explicit Task-mirror decision and `runMirrorPlan` would have routed an `opencode` host down the Claude native path. #886 makes the matrix explicit and test-backed without changing product behavior, preserving the AFK-runner vs interactive-host distinction and the no-cross-runner-abstraction rule.
- **what changed**:
  - `core/mirror.ts`: new `taskMirrorCapability(host)` — an explicit per-host switch (not a generic registry) returning a `TaskMirrorCapability` (`surface`: `native-task` | `monitor-agent` | `headless`, plus `agentDriven`/`nativeTaskApi`/operator note). Unknown host throws. The three sinks (`mirrorPlan`, `codexSinkPlan`, headless none) stay separate; the function classifies, it does not dispatch generically.
  - `commands/monitor.ts`: `runMirrorPlan` now picks the sink by `taskMirrorCapability(host).surface`; `MirrorPlanOptions` gains `host` (`codex` kept as legacy shorthand). `monitor --mirror-plan --runner opencode` resolves to the headless host and emits an empty plan.
  - SKILL.md: a binding host-capability matrix table in *Task Mirror And Codex Monitor Agent*, stating no parity across hosts.
  - `runner-opencode.md`: new *Task mirror (headless — no surface)* section.
  - Tests: `tests/mirror.test.ts` covers the capability decision for all three hosts (distinct surfaces, normalization, loud unknown-host failure); `tests/monitor.test.ts` covers the OpenCode-headless empty plan and the per-host sink routing.

## requeue (engineering) — narrowed safe requeue for blocked:validation/spec (issue #860)

- **status**: modified
- **upstream**: —
- **why**: #850 introduced the base requeue helper; #860 narrows its scope to `blocked:validation` and `blocked:spec` only, refuses mixed `blocked:*` states and label/body kind mismatches (directing the maintainer to `/hitl`), and makes `--guidance` required so every requeue is auditable.
- **what changed** (#860 additions on top of #850):
  - `REQUEUE_SUPPORTED_KINDS` constant guards the two accepted kinds; `refuseForHitl` field on `RequeuePlan` distinguishes `/hitl`-refusal from silent no-op.
  - `planRequeue` now refuses: mixed `blocked:*` labels; label kind not in `{validation, spec}`; active body blocker kind not in `{validation, spec, stalled, crashed, merge-conflict}`; label/body kind mismatch.
  - `requeueCommand` exits 2 when `--guidance` is missing or empty; exits 1 (not exit 0 no-op) when the planner sets `refuseForHitl`.
  - SKILL.md updated: scope narrowed in description, `--guidance` marked required, three `/hitl`-refusal conditions listed, `/requeue`-vs-`/hitl` decision table with explicit pre-conditions.
  - Tests extended to cover all new refusal paths and the guidance-required check.

## requeue (engineering) — safe one-shot requeue for issues parked behind an active Current blocker (issue #850)

- **status**: added
- **upstream**: —
- **why**: A validation/spec failure parks an issue with `ready-for-human`, a `blocked:*` label, and an active `## Current blocker` block. Flipping labels back to `ready-for-agent` by hand is a silent no-op loop: AFK preflight re-reads the active non-mechanical blocker and re-parks the issue. Maintainers needed one safe, documented command to requeue after a human decision makes the issue delegable (issue #850).
- **what changed**:
  - New `plugins/dev/skills/engineering/requeue/SKILL.md` documents `/requeue #N --guidance "…"` and the `/hitl`-vs-`/requeue` split (interactive decision extraction vs already-decided requeue).
  - Implementation: `apps/dev/src/core/requeue.ts` (`planRequeue` plans the clear-blocker + drop-stale-labels + `ready-for-agent` transition; `isRequeueComplete` mirrors preflight so a label flip alone is never a successful requeue) and `apps/dev/src/commands/requeue.ts` (gh-backed command, wired into the CLI router).
  - Tests: `apps/dev/tests/requeue.test.ts` and `apps/dev/tests/requeue-command.test.ts` cover the label-flip-alone invariant, blocker clearing, label transition, no-op/dry-run/closed/missing-arg paths.
  - `plugins/dev/skills/engineering/hitl/SKILL.md` cross-references `/requeue`.

## implement (engineering)

- **status**: added
- **upstream**: `6eeb81b`
- **why**: upstream skill ported and adapted — fills the "implement a PRD myself, guided" gap distinct from the autonomous `/afk` fleet; no equivalent existed in red-skills
- **what changed**:
  - ported upstream 8-line `implement` SKILL.md, rewrote to RedSkills house style (`<what-to-do>`/`<supporting-info>`, 8-technique sentence style)
  - made the AFK-vs-implement boundary explicit: `/implement` is interactive (human-driven, single session, `/ship` to land); `/afk` is autonomous (fleet, claim→worktree→gate→merge→close unattended)
  - replaced "commit to current branch" with the worktree → `/ship` loop
  - wired to our `/tdd`, `/review`, `/to-issues`, and GitHub Issues PRD model instead of Matt's
  - documented the EXISTING-branch worktree form against `origin/<branch>` alongside the new-branch form, with the reason inline: the bare `git worktree add <dir> <branch>` resolves the local ref, which can trail the remote (#2936)

## resolving-merge-conflicts (engineering)

- **status**: added
- **upstream**: `6eeb81b`
- **why**: adopt the upstream conflict-resolution skill into the engineering bucket; no existing human-facing counterpart (AFK handles conflict *recovery* internally, but there was no skill for interactive use)
- **what changed**:
  - new skill at `plugins/dev/skills/engineering/resolving-merge-conflicts/SKILL.md`
  - ported the upstream loop (inspect state → find each side's intent → resolve every hunk → run checks) and rewrote to RedSkills house style (`<what-to-do>`/`<supporting-info>` split + 8 SKILL.md writing techniques)
  - registered in root `README.md`, `plugins/dev/skills/engineering/README.md`, and `plugins/dev/.claude-plugin/plugin.json`

## upstream drift review — 694fa30 → 6eeb81b (#744)

- **status**: reviewed
- **upstream**: `6eeb81b`
- **why**: `red-upstream-watch` flagged ~30 upstream commits past the pinned SHA (#744). Reviewed the full compare, recorded the disposition below, and bumped `.upstream` to `6eeb81b`.
- **what changed**:
  - **Adopting (house-style ports, tracked as separate issues):** `resolving-merge-conflicts` (#807, net-new), `implement` — interactive PRD execution distinct from the autonomous `/afk` (#808), `codebase-design` deep-module vocabulary — reconcile with `improve-codebase-architecture` (#809). Each lands its own `status: added` entry when it merges.
  - **Kept despite upstream removal (deliberate divergence):** `write-a-skill` — upstream replaced it with `writing-great-skills`; ours evolved further under PRD #776. `zoom-out` — part of our context stack (`/context` references graph-aware zoom-out).
  - **Skipped:** `ask-matt` (Matt-specific); `domain-modeling` / `grilling` / `grill-me` / `grill-with-docs` (folded into our `start` + the `.red/` multi-context glossary); `writing-great-skills` (superseded by our `write-a-skill` + the 8-technique convention); `decision-mapping` (upstream in-progress draft); `teach` / `edit-article` / `caveman` (not in our set); `setup-matt-pocock-skills` (we have `setup-red-skills`); all release/changeset/package/CHANGELOG infra (we use `red-release`); and refinements to `triage` / `tdd` / `to-issues` / `to-prd` / `prototype` / `handoff` / `review` / `improve-codebase-architecture` (already rewritten under the PRD #776 convention sweep — adopting upstream diffs would conflict).

## runner-claude-minimax (engineering/afk) — fourth AFK runner targeting MiniMax Anthropic-compatible endpoint

- **status**: added
- **upstream**: —
- **why**: Operators with a MiniMax subscription want a session-auth runner (like Claude Code) that targets MiniMax's Anthropic-compatible endpoint instead of real Anthropic, without requiring an OpenCode install or switching runners. PRD #788 spike validates the approach; issue #795 documents it.
- **what changed**:
  - New `plugins/dev/skills/engineering/afk/runner-claude-minimax.md` documents the runner: explicit-pin selection, env-var injection (`MINIMAX_API_KEY` → `ANTHROPIC_API_KEY/ANTHROPIC_BASE_URL`), model pinned to `MiniMax-M3`, effort capped to `low`, exhaustion/transient-failure detection, working directory.
  - `plugins/dev/skills/engineering/model-tier-policy/SKILL.md` updated to add `claude-minimax` column with tier mappings (all map to `MiniMax-M3` / `low`); executors section mentions the runner.
  - `.red/adr/0070-claude-minimax-runner-anthropic-compat-endpoint.md` (new) records the decision, rejected alternatives (env-toggle, flag, merge into OpenCode), and implementation rationale.
  - `.red/adr/INDEX.md` updated with 0070 entry.
  - Implementation: `apps/dev/src/core/minimax-env.ts` (auth env resolver), `execution.ts` (provider dispatch + effort capping), `runner-detection.ts` (explicit-pin only), `types/runner.ts` (runner discriminated union), tests in `runner-detection.test.ts` and `execution.test.ts`.

## model-tier-policy (engineering) — add claude-minimax tier table entry

- **status**: modified
- **upstream**: —
- **why**: Documentation update for the new `claude-minimax` runner; see runner-claude-minimax entry above.
- **what changed**: Added `claude-minimax` column to the tier table; all tiers map to `MiniMax-M3` / `low` (pinned model, capped effort due to MiniMax-M3 extended-thinking constraint). Runners section expanded to mention the runner doc.

## start (engineering) — single-root `.red/` layout in the file-structure examples

- **status**: modified
- **upstream**: `694fa30`
- **why**: The `start` skill's `SKILL.md` and `CONTEXT-FORMAT.md` taught a layout inherited from upstream that contradicts our own ADRs: ADRs under `docs/adr/` and per-context `.red/` directories nested inside source subtrees (`src/ordering/.red/CONTEXT.md`, `src/ordering/.red/adr/`). The canonical RedSkills model (ADR 0046 → multi-context ADR 0021) is a **single root `.red/`**: ADRs always at `.red/adr/`, context glossaries at `.red/contexts/<name>/CONTEXT.md`, and never a nested `.red/` inside a source tree.
- **what changed**: Rewrote both file-structure trees in `start/SKILL.md` and the context-map example in `start/CONTEXT-FORMAT.md` so everything lives under the single root `.red/` — `docs/adr/` → `.red/adr/`, `src/<ctx>/.red/CONTEXT.md` → `.red/contexts/<ctx>/CONTEXT.md`, with the per-context ADR subtrees removed (one root ADR sequence). Mirrored the same fix in the `setup-red-skills` skill (`SKILL.md` inspection list + `domain.md`) and in `.red/agents/domain.md`. Docs-only.

## brain (plugin) — stop committing the runtime bundle; fetch via the entrypoint (ADR 0038)

- **status**: modified
- **upstream**: —
- **why**: `plugins/brain/dist-bundle/{brain-cli,brain-mcp}.mjs` (786 KB) was checked into git, but the brain entrypoint (`scripts/bootstrap.mjs`) resolves the runtime from a version-keyed `~/.cache` populated from the Release asset, falling back only to `dist/` or the TS source — it never reads `plugins/brain/dist-bundle/*`. The committed bundle was dead weight contradicting ADR 0038's fetch-the-release-asset model, and `plugins/brain/` had no `.gitignore` (unlike `plugins/memory/`).
- **what changed**: `git rm` the two committed bundles and added `plugins/brain/.gitignore` (mirrors `plugins/memory/.gitignore`: `dist/`, `dist-bundle/`, `node_modules/`, `*.tsbuildinfo`) so they can never be re-committed. Also removed stale local-only build artifacts (`plugins/memory/dist*`, root `./dist`) from the working tree — they were already git-ignored, no git change.

## write-a-skill (productivity) — document the eight-technique SKILL.md writing convention + dogfood it

- **status**: modified
- **upstream**: —
- **why**: RedSkills had a *section-level* SKILL.md convention (`<what-to-do>`/`<supporting-info>`) but no *sentence-level* writing guidance, so skill authors had no canonical reference for how each sentence should read. PRD #776 / #777 establishes the eight sentence-level techniques borrowed from `anthropics/launch-your-agent` and makes them discoverable.
- **what changed**: Added a "SKILL.md writing style" section to `write-a-skill` enumerating all eight techniques (bold lead-in + gloss; maxim/slogan compression; prohibition + reason inline; literal phrasing in quotes; vocabulary hygiene; numbered taxonomy; self-demonstrating voice; precondition-carrying headers), each with a one-line before → after. Rewrote the skill's own body to follow the convention (imperative bold lead-ins, prohibitions carrying their reason, precondition in the Review header) so the generator both teaches and follows the style. Added a sentence-level pointer to `CLAUDE.md` beside the existing "SKILL.md body convention" section, framed as additive (it complements, does not replace, the section-level split). Docs-only — no behavioural/runtime change to any bundle, hook, or CLI.

## doctor (engineering) — enforce `plugins.dev.*` config namespacing + migrate legacy top-level keys

- **status**: modified
- **upstream**: —
- **why**: `.red/config.yaml` resolved both top-level `dev.lock.*` and namespaced `plugins.dev.lock.*` (the PR #697 fold), but `/setup-red-skills` *wrote* the top-level form and `/doctor` treated both as equally adopted — so fresh configs came out half-migrated (`plugins.dev.enabled` next to a top-level `dev.lock`) and the doctor never nudged toward the namespace. Captured in ADR 0069.
- **what changed**: Check 6 became **"Config namespacing + primary-branch guard"** — beyond reporting the guard flag, Pass 1 now flags any legacy top-level dev-plugin placement (top-level `afk:`, top-level `dev.lock.*`, flat `lock-primary-branch`) as a namespacing migration finding, and the `--fix` Apply table migrates them into `plugins.dev.*` (delete the top-level orphan; gated confirm-each). The shared runtime writer `activatePrimaryBranchLockConfig` now writes the canonical `plugins.dev.lock.primary-branch: true` (3-level `plugins:`→`dev:`→`lock:` nesting) instead of top-level `dev.lock`, so setup and doctor agree and don't ping-pong. Added ADR 0069; updated `development-workflow.test.ts` + `doctor-docs.test.ts`. Frontmatter `description` lists the new check.

## triage (engineering) — prose rewrite to RedSkills SKILL.md writing convention (PRD #776)

- **status**: modified
- **upstream**: `e74f006`
- **why**: Issue #778 (PRD #776). The skill's directive surface was passive prose: Flows A–D lacked imperative lead-ins, the "Hard rules" section stated prohibitions without consequences, and Flow B step 1 buried its directives in a narrative paragraph. Applied all eight writing-convention techniques as the reference exemplar for the rest of the PRD sweep.
- **what changed**:
  - Added a bold maxim as the opening line: "Triage owns the gate from raw report to agentable issue."
  - Each Flow header now carries its routing trigger in parentheses (technique #8).
  - Each Flow opens with a bold imperative lead-in + inline consequence (technique #1).
  - Flow B step 3 header names its precondition: "mandatory for bugs; skip for enhancements."
  - Three prohibitions in Hard rules gained their consequences via em-dash (technique #3): invented labels → "fragment the queue and break AFK claim queries"; skipping Reproduce → "leaves the agent brief guessing at the code path"; modifying parent while triaging children → "parent state reflects aggregate child state."
  - Flow B step 1 prose compressed from a multi-sentence narrative paragraph to scannable directives (technique #7).
  - No change to the triage state machine, label vocabulary, role names, supporting-info reference material, or outcome table.

## afk (engineering) — SKILL.md convention rewrite: lead-in + ~40% compression of Preconditions/Bootstrap/Issue-Selection (#781)

- **status**: modified
- **upstream**: —
- **why**: PRD #776 house style — imperative lead-in at the top; narration cut from the three densest prose sections while preserving every load-bearing rule.
- **what changed**: Added bold lead-in (`**Read, don't reverse-engineer.**…`) after the title. Compressed **Hard Preconditions** (word-level tightening, ~30% word reduction). Compressed **Bootstrap** (combined steps 1+2; flattened 6-level runner cascade into one ordered-bullet line; removed trailing explanatory paragraph; ~50% line reduction). Compressed **Issue Selection** (merged pull/drop/prepend into one paragraph; removed narration from PRD/urgent explanations; ~41% line reduction). No rule was dropped; overall ~40% line reduction across the three sections.

## ship, hitl, urgent, to-issues, to-prd, report-bug (engineering) — SKILL.md writing-convention sweep: bold lead-ins + primary edits (PRD #776, issue #782)

- **status**: modified
- **upstream**: to-issues `e74f006`; to-prd `aaf2453`; ship `—`; hitl `—`; urgent `—`; report-bug `—`
- **why**: Apply PRD #776 writing convention — imperative bold lead-in on every skill, plus each skill's catalogued primary edit (prose only, no behavioural change).
- **what changed**:
  - **ship**: added bold lead-in; reformatted `--admin` prohibition as `**Do not … — reason.**`.
  - **hitl**: bolded lead-in; converted `## Step N` headings to inline `**Step N — Verb.**` labels.
  - **urgent**: moved "One fire per invocation — no triage bypass for 'I want it sooner'" to the opening line.
  - **to-issues**: added bold lead-in; changed AFK/HITL taxonomy bullets to `(i)/(ii)` numbered form.
  - **to-prd**: added bold lead-in; reformatted `ready-for-agent`/PRD prohibition as `**Do not … — reason.**`.
  - **report-bug**: added "You file, /triage routes. Never pre-label or guess priority." as bold lead-in.

## start (engineering) — convention sweep: bold lead-in, boot header carries precondition, literal Q01 example (PRD #776)

- **status**: modified
- **upstream**: —
- **why**: PRD #776 convention sweep — technique #1 (bold lead-in), #4 (literal phrasing), #8 (phase/step header carries precondition).
- **what changed**: Added a bold imperative lead-in at the top of `<what-to-do>`. Changed `**Boot behavior (turn 1):**` inline bold to `## Boot behavior (turn 1 — first invocation only)` section heading. Replaced the embedded Q01 text in the empty-argument bullet with a literal formatted Q01 block using the question-format template (branches + recommend line).

## reflect (productivity) — convention sweep: bold lead-in + `<what-to-do>` structure (PRD #776)

- **status**: modified
- **upstream**: `e74f006` (renamed-from-grill-me)
- **why**: PRD #776 convention sweep — technique #1 (bold lead-in). Skill was a near-stub with no structural tags, blurring with `/start`.
- **what changed**: Wrapped body in `<what-to-do>`. Added a bold imperative lead-in. Expanded the one-liner into explicit instructions (one question per turn, include recommendation with reason, wait for reply).

## ff (productivity) — convention sweep: bold lead-in, precondition headers, worked example (PRD #776)

- **status**: modified
- **upstream**: —
- **why**: PRD #776 convention sweep — technique #1 (bold lead-in), #4 (literal phrasing — worked example end-to-end), #8 (phase/step headers carry preconditions).
- **what changed**: Added a bold imperative lead-in at the top of `<what-to-do>`. Added precondition phrases to step headers: Step 1 → "(no rewrite yet — stop and wait for the user's pick)"; Step 2 → "(only after the user picks from Step 1)". Added a worked example to `<supporting-info>` showing one framing (e) end-to-end: Step 1 menu output, user pick, Step 2 rewrite + dispatch question, and Yes outcome.

## handoff (productivity) — convention sweep: bold lead-in, maxim, inline template (PRD #776)

- **status**: modified
- **upstream**: `b8be62f`
- **why**: PRD #776 convention sweep — technique #1 (bold lead-in), #2 (maxim), #4 (literal phrasing — inline template block). Was a bare checklist with no lead-in.
- **what changed**: Added bold lead-in + maxim ("Hand over context, not content — reference existing artifacts; do not reproduce them."). Replaced the bare bullet list with an explicit four-field coverage spec (State, Next action, Skills, Refs) followed by a concrete template block in Markdown.

## tdd (engineering) — convention sweep: bold lead-in, spec-language checklist (PRD #776)

- **status**: modified
- **upstream**: —
- **why**: PRD #776 convention sweep — technique #1 (bold lead-in), #4 (literal phrasing — checklist rewritten in spec language "user can…").
- **what changed**: Added bold lead-in at top of `<what-to-do>`. Rewrote per-cycle checklist from implementation-oriented assertions ("Test describes BEHAVIOUR, not implementation") to spec-language items that describe observable outcomes ("A reader can tell what the system does from this test alone — not how it does it").

## prototype (engineering) — convention sweep: bold lead-in maxim (PRD #776)

- **status**: modified
- **upstream**: —
- **why**: PRD #776 convention sweep — technique #1 (bold lead-in) + #2 (maxim). Opening line was passive prose.
- **what changed**: Replaced "A prototype is **throwaway code that answers a question**. The question decides the shape." with a bold imperative maxim: "**Throwaway code answers one question — the question decides the shape.**" followed by an action directive (identify the question, pick the branch, delete once answered).

## setup-red-skills (engineering) — convention sweep: bold lead-in, hoisted prohibition, Section A0 header (PRD #776)

- **status**: modified
- **upstream**: —
- **why**: PRD #776 convention sweep — technique #1 (bold lead-in), #3 (prohibition + reason inline, hoisted to top), #8 (Section A0 header carries its precondition).
- **what changed**: Added bold lead-in that names the `.red/` authorization constraint at the very first line ("this skill is the only thing authorized to create `.red/`"). Hoisted the NEVER prohibition inline with its consequence ("plugins stay fully inert…"). Updated Section A0 header from "Ask this FIRST" postscript to a proper precondition form: "ask first (the per-directory gate)". Removed the now-redundant "only skill authorized" clause from the plugin-activation bullet.

## setup-statusline (engineering) — convention sweep: bold lead-in, gate early-exits marked (PRD #776)

- **status**: modified
- **upstream**: —
- **why**: PRD #776 convention sweep — technique #1 (bold lead-in), #8 (steps that are early exits now say so explicitly).
- **what changed**: Added bold lead-in naming the host-dispatch and gate-stop contract. Steps 2 and 3 relabelled as "**Early exit — opt-out:**" and "**Early exit — already configured:**" so the agent knows to stop rather than fall through.

## diagnose (engineering) — imperative bold lead-in (convention sweep #783)

- **status**: modified
- **upstream**: `e74f006`
- **why**: PRD #776 convention sweep (#783). The old intro prose ("A discipline for hard bugs. Execute the phases in order. Skip a phase only when…") described the skill rather than leading with its highest-impact maxim. Aligning with the house style: first content line is a bold imperative that names the core constraint.
- **what changed**: Replaced the three-sentence intro with a single bold maxim: `**Build the feedback loop first — without one, every subsequent phase is mechanical guesswork.**` No step, rule, or behavioural change; diff is prose only. Refs #783.

## improve-codebase-architecture (engineering) — bold lead-in claim (convention sweep #783)

- **status**: modified
- **upstream**: `e74f006`
- **why**: PRD #776 convention sweep (#783). The opening line had partial bolding (`**deepening opportunities**`) but the sentence itself was not a bold imperative. Aligning with the house style: first content line is fully bold.
- **what changed**: Wrapped the existing two-sentence intro (`Surface architectural friction … The aim is testability and AI-navigability.`) in bold as a single lead-in sentence. No step, rule, or behavioural change; diff is prose only. Refs #783.

## git-guardrails-claude-code (misc) — bold lead-in (PRD #776, issue #785)

- **status**: modified
- **upstream**: `b8be62f`
- **why**: PRD #776 convention sweep — every skill opens with an imperative bold lead-in.
- **what changed**: Added "**Block destructive git ops before they run.**" as the first bold sentence after the H1.

## migrate-to-shoehorn (misc) — bold lead-in + named functions (PRD #776, issue #785)

- **status**: modified
- **upstream**: `e74f006`
- **why**: PRD #776 convention sweep; "type-safe alternatives" was vague — the functions have names.
- **what changed**: Added bold lead-in. Replaced "type-safe alternatives" with "`fromPartial()` for partial data and `fromAny()` for intentionally wrong types."

## setup-pre-commit (misc) — bold lead-in (PRD #776, issue #785)

- **status**: modified
- **upstream**: `e74f006`
- **why**: PRD #776 convention sweep — every skill opens with an imperative bold lead-in.
- **what changed**: Added "**Enforce lint + tests before commit.**" as the first bold sentence after the H1.

---

## ff (productivity) — two-step interactive flow: choose framing, then dispatch prompt

- **status**: modified
- **upstream**: —
- **why**: The old `/ff` dumped all seven framings at once and made dispatch an invocation-time flag. The desired UX is two sequential questions with user interaction between them — pick the framing first, then decide whether to execute the single rewrite.
- **what changed**: Restructured the skill into two steps. **Step 1** asks `How do you want to rewrite your content?` and presents the framing menu (a–g) with one recommendation, then stops — no rewrite generated yet; the user picks by label. **Step 2** generates only the chosen framing's rewrite, prints `Result: {result}`, and asks `Would you like to dispatch it? Yes/no` — Yes adopts the rewrite as the active message and executes the underlying task, No hands it back and stops. `--dispatch`/`-d` is kept as an auto-yes shortcut that skips the Step 2 question. Dropped the all-previews-at-once output and the compare/mix affordance (conscious trade-off for a cleaner flow). Restructured the body into `<what-to-do>` / `<supporting-info>` and updated the frontmatter `description`. README, productivity bucket README updated to match.

## branch-lock (misc) + dev codex hooks — extend the ADR 0067 gate to the non-launcher hook surface

- **status**: modified
- **upstream**: —
- **why**: The first ADR 0067 cut gated the bundle launchers but three dev hooks bypass them and stayed proactive in repos that never opted in: branch-lock ran git+file reads on every Bash call; `ensure-codex-statusline.mjs` rewrote the user's GLOBAL `~/.codex/config.toml` every session; and `red-fetch.mjs code-nav` gated on a `plugins.code-nav` flag that is never set (so code-nav stopped warming even when dev was on — a regression).
- **what changed**:
  - `branch-lock/scripts/lib/dev-config.sh`: generalized the YAML reader into `_dev_config_scalar_true`; added `dev_plugin_enabled` (strict `plugins.dev.enabled: true`).
  - `branch-lock/scripts/branch-lock-hook.sh` + `plugins/dev/hooks/branch-lock-codex.sh`: early-exit via `dev_plugin_enabled` before any scope/lock/git work.
  - `plugins/dev/hooks/ensure-codex-statusline.mjs`: inline gate (mirror of plugin-gate) — no global-config write unless dev is enabled in the cwd's project.
  - `packages/shared/entrypoint-cli.ts`: `gatePluginName` aliases `code-nav → dev` for the fetch/run gate; automatic run subcommands (`route-model-tier`, `statusline`) are silent when gated off, interactive ones keep the setup hint. `gatePluginName` exported + unit-tested.

---

## setup-red-skills (engineering) — sole `.red/` creator + plugin activation prompt (ADR 0067)

- **status**: modified
- **upstream**: —
- **why**: RedSkills plugin hooks install globally on every agent, so they fired in every directory even when the user did not want dev/memory/brain there. ADR 0067 makes plugins strict opt-in per directory (`plugins.<name>.enabled: true` in `.red/config.yaml`) and designates `/setup-red-skills` as the only authorized creator of `.red/` and the only way to enable a plugin.
- **what changed**:
  - New **Section A0 — Plugin activation** asked first: a multi-select of `dev`/`memory`/`brain` to enable in this repo, with the strict-opt-in / sole-`.red`-creator contract spelled out.
  - Section G + step 4 now write the `plugins.<name>.enabled` flags (and, for an existing `.red/config.yaml`, *surgically merge* just those flags — the sole exception to the no-clobber rule), instead of copying a fully-commented template that would leave every plugin disabled under the new gate.
  - `config-template.yaml` ships an active `plugins:` block (`dev.enabled: true` baseline; `memory`/`brain` commented), with the `dev.lock` example folded under `plugins.dev`.
  - Frontmatter/intro/Done updated to describe the gate and to point memory/brain enablers at their own init.

---

## teaching (upstream addition — skipped)

- **status**: skipped
- **upstream**: `694fa30311e02c2639942308513555e61ee84a6f`
- **why**: Upstream added a `teaching` skill (lesson guidelines, citation patterns, fluency-vs-storage-strength pedagogy). Not relevant to reddb.io's engineering-automation focus; we do not carry teaching skills.
- **what changed**: nothing — skipping adoption

---

## afk (engineering) — execution-environment command surface documented; Actions lane #631 ready-for-agent (#640, ADR 0059)

- **status**: modified (docs + first published reusable workflow)
- **upstream**: —
- **why**: The OpenCode runner merged in #626/#640 runs the same `/afk --issues N --runner opencode --once` invocation regardless of where it is invoked from. Adopters who want to drive it from a GitHub Actions runner or a k8s pod need (a) a published reusable workflow they can `uses:` from their own repo, (b) auto-trigger on `ready-for-agent` label application (so the issue lifecycle drives the lane, not a human pushing a button), (c) a trust gate rigorous by default (claim refused unless the issue author and label-applier are allowlisted).
- **what changed**:
  - `.github/workflows/reusable-afk-attempt.yml` (NEW): published reusable workflow in `reddb-io/red-skills`. Single file, three triggers (`workflow_call` + `workflow_dispatch` + `issues: types: [labeled]`), `if:` filter restricts to the `ready-for-agent` label, `actions/github-script@v7` resolves the issue number from any of the three trigger sources, evaluates the trust gate, and on pass/bypass invokes `node plugins/dev/skills/engineering/afk/bin/afk.mjs run --issues <N> --runner opencode --once`. Trust gate inputs (`allowlist_authors`, `allowlist_label_actors`, `enforce_trust_gate`) are passed by the caller. `permissions:` is `contents: write, issues: write, pull-requests: write` — no `id-token`, no `actions: write`.
  - `plugins/dev/skills/engineering/afk/examples/rs-afk-attempt.yml` (NEW): thin caller template for adopters who want explicit control over the trigger and allowlist in their own repo. ~50 lines, copies verbatim, edits 2 allowlist values.
  - `plugins/dev/skills/engineering/afk/SKILL.md`: new *Running `/afk` in an execution environment (GitHub Actions / k8s)* subsection under *When To Use* documents the three trigger surfaces, the env-var injection surface, the runtime/caller responsibility split, the recommended `--permissions:` block, and the trust-gate-by-default contract. No new subcommand — the existing `/afk --issues N --runner opencode --once` IS the execution-environment command.
  - `.red/contexts/dev/CONTEXT.md`: two new glossary terms — *Execution environment* (GHA + k8s, shared runtime contract) and *Actions lane* (the GHA reusable-workflow surface of the execution environment) — with avoid-antonyms.
  - Issue [#631](https://github.com/reddb-io/red-skills/issues/631): body updated to reflect the new trigger model — the reusable workflow IS the entry point (not a separate caller + reusable), trust gate lives inside the reusable, hard deps mapped to #621 (runtime allowlist predicate, to remove the hard-coded maintainer fallback) and #622 (atomic claim CAS, to replace the `--issues <N>` direct invocation with a server-side CAS).
- **note**: the runtime trust-gate predicate (#621) is the dependency that gates removing the hard-coded `filipeforattini` fallback in the auto-trigger path. Until #621 lands, the reusable is correct for the reddb-io/red-skills repo (hard-coded allowlist matches the maintainer set) and for adopter repos whose allowlist is supplied via `workflow_call` inputs.

---

## afk (engineering) — OpenCode runner is endpoint-agnostic; env-precedence auth (OPENAI > MINIMAX > OPENROUTER) (#638, ADR 0059 amendment 1+2)

- **status**: modified
- **upstream**: —
- **why**: The #626 runner hardcoded OpenRouter (`OPENROUTER_API_KEY` only, `openrouter/<vendor>/<model>` slug only). A maintainer with a MiniMax subscription API key could not drive the runner without spinning up an OpenRouter account and paying the relay tax. The same shape blocked OpenAI-direct users. Endpoint resolution belongs in OpenCode, not in AFK.
- **what changed**:
  - `src/apps/dev/src/core/opencode-env.ts` (new, pure): `resolveOpenCodeAuth(env)` returns the first-set auth env-var by precedence; `openCodeAuthEnv(auth)` builds the `{ [envVar]: value }` payload for `OpenCodeOptions.env`; `OPENCODE_AUTH_ENV_PRECEDENCE` lists the three entries. Empty-string values are treated as unset (fail-safe against shell-rc placeholders).
  - `src/apps/dev/src/core/execution.ts`: `buildAgent` opencode branch now calls the resolver; when no precedence entry is set, the agent is spawned without an auth `env` block (fail-closed — OpenCode surfaces its own auth error, the run routes through the normal failure path). The `OPENROUTER_API_KEY_ENV` constant is retained as a `@deprecated` back-compat export; new callers should use `OPENCODE_AUTH_ENV_PRECEDENCE`.
  - `src/apps/dev/src/core/config.ts`: tier defaults are unchanged (`openrouter/anthropic/...`) for #626 back-compat; the surrounding comment now documents the `<provider>/<model>` shape and that operators may point the tiers at any OpenAI-compatible endpoint.
  - `plugins/dev/skills/engineering/afk/runner-opencode.md`: rewritten as an endpoint-agnostic contract; new *Auth env precedence* section names the three env-vars, their slug prefixes, and the rationale for the order.
  - `plugins/dev/skills/engineering/afk/SKILL.md`: runner-fallback note points at the new precedence table.
  - `.red/adr/0059-…md`: status is now `accepted, amended`. Amendment 1 records the principled design shift (AFK only propagates the key, OpenCode owns endpoint resolution). Amendment 2 anchors the decision in the concrete MiniMax subscription case and commits to keeping the property load-bearing.
  - `.red/adr/INDEX.md`: 0059 entry updated to mention both amendments.
  - `.red/contexts/dev/CONTEXT.md`: two new glossary terms — *OpenCode auth env precedence* and *Endpoint-agnostic provider* — with avoid-antonyms.
  - Tests: 10 new unit tests in `tests/opencode-env.test.ts` (precedence, fail-closed, unrelated-env-var immunity, buildEnv shape) + 3 new tests in `tests/execution.test.ts` (`<provider>/<model>` slug passthrough for `openai/` and `minimax/` prefixes, OPENAI-beats-MINIMAX-beats-OPENROUTER precedence, MINIMAX-beats-OPENROUTER). Total: 1239/1239 tests pass; typecheck clean.
- **back-compat**: when only `OPENROUTER_API_KEY` is set, behaviour is byte-for-byte identical to the pre-amendment runner (same slug flow, same env payload name, same config defaults). No existing config, test, or contract changes are required to adopt the new precedence-aware env resolver.

---

## afk (engineering) — SAFETY.md git bans scoped to inner agent; push/branch-name claims corrected (#592)

- **status**: modified
- **upstream**: —
- **why**: Binding doc SAFETY.md forbade `git rebase` and `--force-with-lease` "no exceptions" while the orchestrator's own documented flow (SKILL.md steps 2 and 8) relies on both for worktree-branch mirroring and base integration. Similarly, SAFETY.md claimed "the orchestrator pushes `main`, not the worktree branch" while the actual flow pushes the worktree branch via PR admin-merge or direct locked-branch merge + push. Two different branch-name templates were listed (`afk/{id}/{N}-{slug}` vs `afk/{N}-{slug}`) with the second missing the worker ID.
- **what changed**:
  - Scoped the git bans by actor: `git rebase` and `--force-with-lease` remain forbidden for the inner agent, but are now explicitly allowed for the orchestrator in the primary checkout (rebase for integration, `--force-with-lease` for mirroring the worktree branch onto `origin/afk/{id}/{N}-{slug}` and per-worktree post-commit hook).
  - Rewrote the "pushes main" claim to state the actual mechanism: the orchestrator pushes the worktree branch via PR admin-merge (unlocked path) or direct merge + push of the locked branch (locked path); it does not push `main` directly.
  - Unified the branch-name template to always use `afk/{id}/{N}-{slug}` (with worker ID); corrected the Worktree Lifecycle section which listed the older incomplete form. Also clarified that worktrees are created from `origin/{pinned}` (the resolved base), not `origin/main`.

---

## afk (engineering) — idle queue does not park fleet permanently; clean drain exempt from fast-death ring (#578)

- **status**: modified
- **upstream**: —
- **why**: An empty `ready-for-agent` queue made `run --once` exit within seconds (NO_MORE_TASKS / exit 0). The supervisor did not capture the exit code and classified the clean exit as a sub-30s fast-death, so a drained fleet tripped the circuit breaker and parked every slot permanently with no un-park path.
- **what changed**:
  - `src/apps/dev/src/commands/supervise.ts`: track each child's exit code in a `slotExitCodes` Map; expose it via `lastExitCode(slot)` on `SupervisorProc`.
  - `src/apps/dev/src/core/supervisor.ts`: (1) `handleDeadSlot` checks `lastExitCode` — exit 0 (NO_MORE_TASKS) bypasses `recordDeath` entirely so the fast-death ring never fills on idle drains; (2) clean drain with empty queue enters new `idleParked` state (no sweep, no discard envelope, no respawn timer); (3) clean drain with non-empty queue respawns immediately without feeding the breaker; (4) each superviseTick fetches `readyQueueDepth` once and un-parks `idleParked` slots when depth > 0; (5) `spawning` flag on `SlotState` prevents a double-spawn if a tick is abandoned mid-`spawnSlot`; (6) `pollStallDetector` skips idle-parked slots; (7) `fleetSlotCounts` counts both `parked` and `idleParked` in `slotsParked`.
  - `src/apps/dev/tests/supervisor.test.ts`: 14 new tests covering idle-drain-does-not-trip, exit-0-not-fast-death, queue-refill-unparks-idle, and spawning-guard double-spawn prevention.

---

## afk (engineering) — circuit-tripped slot restores claimed issue; boot-stamp makes sweep reliable (#577)

- **status**: modified
- **upstream**: —
- **why**: Three related bugs in the circuit-trip sweep (`sweepParkedSlot`). (1) The sweep resolved parked-slot workers from a per-slot log file (`afk-supervisor-slot-N.log`) that the native supervisor routed child stdout to but the worker never wrote a `[afk] worker: wXXXX` boot-stamp line into — so `parseWorkerIdsFromLog` always returned `[]` and the sweep always early-returned, stranding the claimed issue in `running` forever with no label restore and no discard envelope. (2) The PID-based fallback path (`findSlotIterDir`) was never reached in practice because the log-parse short-circuit fired first. (3) The discard envelope's fast-death count was always correct in the model (`state.deaths.length`) but was never verified to reach the envelope in an end-to-end test — a pure-fake test exercised it, but no test drove the real `parkedSlotWorkFor` filesystem path.
- **what changed**:
  - `src/apps/dev/src/commands/run.ts`: emit `[afk] worker: ${workerId}` to stdout immediately after generating the worker ID, before any I/O that could fail. The supervisor routes the child's stdout/stderr to the per-slot log, so the stamp is captured even when the worker fast-dies before writing `worker.pid`. This makes Path 1 (slot-log boot-stamp parse) the primary sweep-resolution path for the native fleet.
  - `src/apps/dev/src/runtime/supervisor-fs.ts`: updated doc comments to reflect Path 1 as primary (native fleet) and Path 2 as fallback (rotated / pre-stamp logs).
  - `src/apps/dev/src/core/supervisor.ts`: updated `SupervisorFs.parkedSlotWork` doc comment to match.
  - `src/apps/dev/tests/supervisor.test.ts`: added a real-FS integration describe block (`circuit trip — real FS integration (slot-log boot-stamp path)`) that drives the full path `handleDeadSlot → sweepParkedSlot → parkedSlotWorkFor` against a real temp directory with boot-stamp log + worker iter dirs, verifying (a) the claimed issue is restored with `ready-for-agent`/`runner-error` labels, (b) the discard envelope carries `fast deaths: 5` (not 0), and (c) pre-claim iter dirs are also cleaned up.
  - `src/apps/dev/tests/supervisor-fs.test.ts`: separate test suite for `parkedSlotWorkFor` real-FS paths (slot-log parse, PID fallback, empty log, missing file, multi-slot isolation).

---

## model-tier-policy / branch-lock + Codex dev manifest (engineering, misc) — frontmatter + manifest hygiene (#593)

- **status**: modified
- **upstream**: —
- **why**: Three `dev`-plugin hygiene defects surfaced by the #567 super-checkpoint audit: `model-tier-policy/SKILL.md` was the only skill missing the `name:` frontmatter field; the Codex dev manifest exposed the whole `./skills/` tree (so `in-progress/` drafts would ship, violating CLAUDE.md rule 1); and the branch-lock classifier scanned only `git <subcommand>`, so a `git -C <path> checkout <branch>` (or any global-option form) slipped past the lock — a narrow bypass.
- **what changed**: Added `name: model-tier-policy` to the SKILL.md frontmatter. Restricted `plugins/dev/.codex-plugin/plugin.json` `skills` from the `./skills/` glob to an explicit array of the four published buckets (`engineering/`, `knowledge/`, `productivity/`, `misc/`), excluding `in-progress/`. Broadened `git-command-classifier.sh` with a `_git_subcommand_index` helper that skips global options (`-C <path>`, `-c <k=v>`, `--git-dir[=]`, `--work-tree[=]`, `--namespace`, `--exec-path`, `--super-prefix`, and bare flags like `--no-pager`) before reading the subcommand, in both `classify_git_command` and `classify_primary_branch_switch_guard`. Extended the bash classifier test with global-option block/allow cases and added a TS `manifest-parity.test.ts` covering the frontmatter field and the bucket-only Codex manifest.
## setup-red-skills (engineering) — Section F writes the cached-bundle-first statusline command (#591)

- **status**: modified
- **upstream**: —
- **why**: Section F emitted a statusline command that resolved only the plugin cache and the launcher `afk.mjs`. Since ADR 0038 the launcher does a synchronous network fetch on a cold cache, so a bootstrapped repo's statusline blanked on every plugin update — a regression `/doctor` already flagged (and flagged Section F itself as drifted until patched). `setup-red-skills` and `setup-statusline` disagreed on the canonical command.
- **what changed**: Replaced the Section F `statusLine` JSON block with the two-tier **cached-bundle-first** form from `setup-statusline` (resolve the highest-version `~/.cache/red-skills/bundles/dev-*.bundle.min.mjs` first, fall back to the launcher only when no bundle is cached). The command is now byte-identical to `setup-statusline`'s. Updated the accompanying explainer to describe the cache-first resolution and why it keeps the network out of the statusline hot path. Removed the now-stale known-drift note in `doctor/SKILL.md`'s Fix-home table that flagged Section F as still emitting the old command.

## hitl (engineering) — ignore the loop's own prior resolution directive + shed stale blocked:* labels (#586)

- **status**: modified
- **upstream**: —
- **why**: On a HITL re-loop, the pending-decision extractor re-read the loop's own prior `<details data-kind="directive"><summary>HITL resolution</summary>` comment and surfaced the literal placeholder label `Pending decision:` instead of the real `## Current blocker` next-field. Separately, a delegable resolution moved the issue back to `ready-for-agent` while still wearing the stale `blocked:*` reason that parked it.
- **what changed**: Documented in Step 3 that extraction must ignore self-authored HITL-resolution directives (summary `HITL resolution`, or a first useful line that is a bare field label like `Pending decision:`), and in the delegable mutation step that every stale `blocked:*` label is shed alongside `ready-for-human`. Mirrors the runtime fix in `src/apps/dev/src/core/hitl-decision-extraction.ts` and `hitl-resolution-plan.ts`.

## afk (engineering) — inner agent must not create PRs / wait on CI; commit + DONE only

- **status**: modified
- **upstream**: —
- **why**: A live fleet worker did the work, then **created its own PR and "waited for CI"** instead of emitting `<promise>DONE</promise>`. Because it never signalled DONE, the orchestrator stalled behind it; the next re-invocation opened a **second duplicate PR** for the same issue — which had meanwhile been landed and closed — so the worker ground an already-closed issue and littered duplicate PRs until the attempt guard would reap it. The AGENT-PROMPT documented "the orchestrator owns the merge gate" but never explicitly forbade `gh pr create` / `gh pr merge` / `gh issue close` / CI-waiting on the inner agent (only the reddb run avoided it via an ad-hoc `-r` block).
- **what changed**: Added a binding rule to *What "Done" Means* in `AGENT-PROMPT.md`: the inner agent stops at commit + `DONE`; it must NOT run `gh pr create` / `gh pr merge` / `gh issue close` or any land command, and must NOT wait for / poll CI or external review checks. PR/merge/close/CI is orchestrator mechanism that runs *after* the sentinel. Names the exact runaway (self-PR → no DONE → orchestrator stall → duplicate PR on re-invocation → grinding a closed issue) so the rule is grounded.

## ff (productivity) — translate to English + `--dispatch` flag; default is reframe-only (no auto-execute)

- **status**: modified
- **upstream**: —
- **why**: Two issues. (1) `/ff` shipped a Portuguese body (recommendation template, the seven option labels, trigger phrases), violating the repo English-only rule and emitting Portuguese to every consumer (subsumes #590). (2) The old contract auto-continued the underlying task once the user picked a framing, so `/ff` "went executing all at once" instead of just handing the rewritten prompt back.
- **what changed**: Translated the entire skill to English (recommendation line `I think you want (x), because …`, the seven option labels, and the trigger phrases `use a` / `mix a with d` / `go with that one`). Split behavior into two modes: **default** `/ff <text>` reframes, lets the user pick, then outputs the finalized rewrite and **stops** (hands it back — never executes); new **`--dispatch`/`-d`** flag (`/ff --dispatch <text>`) reframes, lets the user pick the format, and then **runs** the underlying task with that framing. Updated the frontmatter `description` and `argument-hint` accordingly.

## afk (engineering) — AGENT-PROMPT foreground-execution rule + drop stale pre-sandcastle machinery

- **status**: modified
- **upstream**: —
- **why**: Inner agents were running tests/commands in the background and polling a log (`until grep …`) for completion, so they never read the real exit code/output — crashes, panics, and stderr were misread as success, and they committed broken work on a false belief that it passed. Reported live during an AFK run ("não conseguir ler gera muito bug por não entender o que está acontecendo").
- **what changed**: Rewrote the *Background Tasks and Polling* section of `AGENT-PROMPT.md` around one cardinal rule — run every result-bearing command in the **foreground**, wait for it to return, and **read its actual output**; never `run_in_background` a command whose result you need; never poll a log to detect completion; a slow command is solved by a longer `timeout`, not by polling. Also removed the obsolete pre-sandcastle machinery the section still claimed as live (the 30s post-sentinel pipe watchdog and the `pnpm` PATH `timeout` shim — neither exists under sandcastle, ADR 0033) and re-pointed the "safety net" language at the real bounds (idle-timeout, max-iterations, commit-anchored attempt guard). Subsumes the `AGENT-PROMPT.md` portion of #592.

## afk (engineering) — emit DONE after final commit, no post-commit re-validation loop (#557)

- **status**: modified
- **upstream**: —
- **why**: Issue #557 / ADR 0055 (preventive half). Inner agents were re-running a full-suite "sanity" pass *after* their final commit; with no new commit produced, the commit-anchored attempt guard treated the still-grinding agent as stalled and parked the work (#407, #456). The runtime already flags this as the real fix (`src/apps/dev/src/core/execution.ts:84-88`); the prompt previously only forbade *backgrounding* the gate, not the post-commit foreground re-run.
- **what changed**: Added a rule to *What "Done" Means* in `AGENT-PROMPT.md`: after the final commit, do not run a full-suite pass; run the touched package's gate at most once for confidence, then emit `<promise>DONE</promise>` immediately. Names the orchestrator's Feedback-loops step as the merge authority and the commit-anchored attempt guard as the failure mode a second full-suite run triggers.

---

## to-prd (engineering) — upstream testing seam wording (#325)

- **status**: modified
- **upstream**: `aaf2453`
- **why**: upstream shifted PRD planning away from extracting deep modules by default and toward agreeing on the highest useful testing seams.
- **what changed**:
  - Replaced the deep-module extraction prompt in step 2 with testing-seam planning language while preserving RedSkills' HITL capture and PRD label guardrails.
  - Updated the PRD testing-decision prompt to allow seams as well as modules.

---

## afk — SKILL.md execution layer rewritten to match sandcastle reality (#352)

- **status**: modified
- **upstream**: —
- **why**: PRD #351 / issue #352. The skill's runtime/invocation prose still described a fictional execution layer — a `claude -p` / `codex exec` session whose stdout was grepped for stages, plus an "attempt-exit reader" teardown pipeline (`RED_AFK_ATTEMPT_GRACE_S`, `RED_AFK_ATTEMPT_KILL_S`, `RED_AFK_WATCHDOG_GRACE_S`, recursive SIGTERM/SIGKILL of `claude|jq|grep|tee`) that does not exist in `src/apps/dev/src/`. Execution actually runs on `@ai-hero/sandcastle` (ADR 0033) as a single `runAgent` call, terminated by the `<promise>` completion signal and bounded by `idleTimeoutSeconds` / `maxIterations` / a commit-anchored attempt guard.
- **what changed**: re-verified every claim against `src/apps/dev/src/core/execution.ts` and `runtime/wire.ts`:
  - Added an **Execution Substrate (ADR 0033)** section: sandcastle owns spawn/worktree/sandbox/stream/completion-signal/landing; AFK owns issue policy; the Orchestrator is driven via injected providers (`SandcastleDeps`: `run`, `agentFor`, `sandboxFor`); execution is a single `runAgent` call, not a multi-mode dispatch.
  - Rewrote Per-Issue Loop step 5 (**Inner agent**) from "invoke claude/codex, grep stdout for stages" to the sandcastle `runAgent` call (handoff `promptFile`, provider/sandbox/branchStrategy, `onAgentStreamEvent`).
  - Replaced **The attempt-exit reader** section with **Attempt Completion & Termination Bounds**: deleted the non-existent grace/kill/watchdog teardown knobs and recursive-kill pipeline; documented the three real bounds — `idleTimeoutSeconds` (default 600s, `RED_AFK_IDLE_TIMEOUT_S`), `maxIterations` (default 12, `RED_AFK_MAX_ITERATIONS`), and the commit-anchored attempt guard (default 2700s, `RED_AFK_ATTEMPT_TIMEOUT_S`, no-sandbox only) — plus the `exhausted` / `runner-transient` / `no-sentinel` outcome split. Tied the busy-predicate gate (thread discussion / #362–363) to the fleet stall reaper, which is the predicate-gated bound.
  - Added Configuration rows for `RED_AFK_IDLE_TIMEOUT_S` and `afk.attempt_timeout` / `RED_AFK_ATTEMPT_TIMEOUT_S` with correct defaults and precedence; corrected the Stage Detection + Heartbeat prose from `run_inner` stdout tee to the sandcastle stream capture.
  - The "Capability Dispatch (#202)" run-mode table was already absent (no `RED_AFK_RUN_MODE` / `claude-native` / `codex-phased` / `hermes-fallback` references remain); confirmed and left removed. `maxIterations` default is **12** in source, not the 25 named in the issue text — documented the source value.

---

## branch-lock / git-guardrails-claude-code (misc) — primary checkout branch guard (#396)

- **status**: modified
- **upstream**: —
- **why**: ADR 0043 needs the interactive dev loop enforced by the existing agent-only guardrail path, dormant until a repo opts into `dev.lock-primary-branch`.
- **what changed**:
  - Added a `dev.lock-primary-branch` runtime flag reader and primary-branch-switch classifier. With the flag true in the primary checkout, agent `git switch <branch>`, `git checkout <branch>`, and `git switch -b <new>` are denied without requiring a branch-lock file.
  - Kept `git commit`, `git worktree add`, read-only git, and `.red/tmp/work-*/` worktrees allowed; missing config/key stays off.
  - Wired the Claude dev plugin hook manifest with dormant `PreToolUse(Bash)` enforcement and reused the existing Codex plugin hook.
  - Extended standalone `git-guardrails-claude-code` independently, preserving its no-dependency-on-branch-lock contract.
  - Added shell tests for the classifier table, config flag reader, Claude/Codex plugin hooks, and git-guardrails coverage; added the TypeScript config default/test.

## afk — post-3d92d56 in-window runtime backfill (#358)

- **status**: modified
- **upstream**: —
- **why**: `CHANGES.md` last recorded the native statusline / legacy-shell removal at `3d92d56`, but the next in-window AFK runtime cuts were missing from the audit trail.
- **what changed**:
  - `f3213c3`: structured dependencies as `req:N` edge labels, kept dependency waits on `blocked:dependency` instead of `ready-for-human`, and added both event-driven close-cascade unblocking and the boot-time unblock sweep.
  - `ee680c6`: added typed `blocked:<reason>` labels to every terminal blocked route, with automatic label creation and outcome-derived reasons such as `blocked:quota`, `blocked:validation`, `blocked:spec`, `blocked:stalled`, and `blocked:infra`.
  - `0a0c35d`: batched boot issue-state lookups so `/afk` performs one `gh issue list` pass for open issue state instead of N per-dependency `gh issue view` calls.
  - `953f332`: made `--boot-only` an honest dry-run that executes boot sweeps/prechecks and exits before issue selection or agent spawn; boot reads were parallelized and the smoke harness adjusted to that contract.
  - `1517abe`: anchored sandcastle's `.sandcastle/` runtime under the per-attempt directory (`.red/tmp/workers/{id}/{N}-a{n}/`) instead of the repository root, keeping execution scratch out of the primary checkout.
  - `9ab3d27`: fixed the statusline installer to resolve the installed AFK bundle from the plugin cache instead of relying on `$CLAUDE_PLUGIN_ROOT`, which Claude Code does not expose to `statusLine` commands.
  - `a32c3a2`: raised the sandcastle inner-agent `maxIterations` ceiling from sandcastle's effective one-turn default, added `RED_AFK_MAX_ITERATIONS` / config overrides, and guarded the setting with tests.
  - `1f6c235` / `6283403`: cut and documented v1.142.0 for the #322 maxIterations fix plus the session fixes above (`--boot-only`, boot batching, and sandcastle-under-attempt-dir).

---

## setup-statusline (engineering) — host statusline installer provenance + rework

- **status**: renamed-from-statusline
- **upstream**: —
- **why**: The statusline installer is original to reddb.io and was heavily reworked in the v1.142-era window, but it had no standalone change record separate from the AFK runtime statusline command.
- **what changed**:
  - Added provenance for the original-to-reddb statusline installer skill: it wires host-specific statusline support around the AFK bundle's `statusline` producer rather than adapting an upstream Matt Pocock skill.
  - `9ab3d27` reworked the Claude Code path to use an installed-bundle lookup (`sort -V | tail -1`) instead of `$CLAUDE_PLUGIN_ROOT`, preserving renderability inside Claude Code's restricted `statusLine` environment.
  - `0e8c648` / `51ffc71` renamed the skill from `statusline` to `setup-statusline` and updated README, plugin manifest, engineering bucket docs, and `/setup-red-skills` references. Current disk path: `plugins/dev/skills/engineering/setup-statusline/SKILL.md`.
  - The current skill also documents the Codex limitation: Codex has built-in footer items but no command-backed statusline, so the AFK worker block remains Claude Code only until Codex supports command hooks.

---

## migrate-to-shoehorn (misc) — upstream provenance

- **status**: added (upstream-derived)
- **upstream**: `e74f006`
- **provenance**: inherited from `mattpocock/skills` during the marketplace/plugin restructuring (`7792235`), retained under `plugins/dev/skills/misc/migrate-to-shoehorn/`.
- **why**: Keep the upstream-derived misc skill visible in the RedSkills audit trail, even though this repo has not materially reworked the body beyond relocation into the dev plugin.
- **what changed**: No RedSkills behavioural divergence recorded in this window; the skill remains the test-only guide for replacing TypeScript `as` assertions with `@total-typescript/shoehorn`.

---

## setup-pre-commit (misc) — upstream provenance

- **status**: added (upstream-derived)
- **upstream**: `e74f006`
- **provenance**: inherited from `mattpocock/skills` during the marketplace/plugin restructuring (`7792235`), retained under `plugins/dev/skills/misc/setup-pre-commit/`.
- **why**: Keep the upstream-derived misc skill visible in the RedSkills audit trail, even though this repo has not materially reworked the body beyond relocation into the dev plugin.
- **what changed**: No RedSkills behavioural divergence recorded in this window; the skill remains the Husky/lint-staged/Prettier pre-commit setup guide.

---

## hitl (engineering) — dedicated human-decision queue workflow (PRD #364)

- **status**: added
- **upstream**: —
- **why**: PRD #364. `ready-for-human` had become an informal residue of triage and AFK blockers, while the obsolete `slice:hitl` / `slice:afk` labels duplicated live queue state and made label meaning drift. The maintainer wanted a dedicated `$hitl` vertical for resolving pending human decisions and promoting issues back to autonomous execution when possible.
- **what changed**:
  - Added `plugins/dev/skills/engineering/hitl/SKILL.md`, a workflow that selects open non-PRD `ready-for-human` issues, supports skip, extracts the pending decision, records the maintainer answer as a Directive block, and either keeps the issue in the HITL queue with the next pending decision or moves it to `ready-for-agent` with a refreshed `## Agent brief`.
  - Added pure HITL core modules in `src/apps/dev/src/core/`: queue selection, pending-decision extraction, and resolution planning. GitHub access stays at the runtime boundary via `runtime/gh.ts`.
  - Removed `slice:hitl` and `slice:afk` from the taught label vocabulary, setup docs, triage/to-issues/report-bug guidance, examples, and tests. HITL slices now publish directly as `ready-for-human`; AFK-safe slices publish directly as `ready-for-agent`.
  - Registered the skill in the dev plugin documentation and Claude manifest so released installations expose `$hitl`.
  - Added regression tests for label vocabulary, HITL selection, decision extraction, and resolution planning. Refs #365, #366, #367, #368, #369.

---

## afk — AGENT-PROMPT forbids backgrounding the feedback suite + the self-matching pgrep poller (#362)

- **status**: modified
- **upstream**: —
- **why**: Issue #362. The inner agent could write a self-deadlocking poller that hangs the worker forever. Observed live on #302 (worker wKXWG): the agent ran vitest in the background, then polled with `until ! pgrep -f vitest; do sleep 3; done`. `pgrep -f vitest` matches the polling shell's *own* argv (which contains the string `vitest`), so the negated condition is never true → infinite loop. vitest had long finished; a solo `run` worker has no idle reaper, so it would hang indefinitely. Same family as #216 / #322. This fixes the source — the orchestrator-side backstop is #363.
- **what changed**: Rewrote the *Background Tasks and Polling (binding)* section of `AGENT-PROMPT.md`:
  - Added a binding rule that the inner agent must **never background the feedback suite (`test`/`typecheck`/`lint`/`build`) to poll for it** — the orchestrator runs those gates itself in the Feedback-loops step after the agent commits; the agent edits and commits, validation is the orchestrator's mechanism.
  - For any other `run_in_background` wait loop, mandated that it (1) never match by a literal string that appears in the loop's own command line — match by the captured job PID or use the bracket trick (`pgrep -f '[v]itest'`), citing the #302 self-match trap — and (2) carry a hard wall-clock deadline. Updated the worked example to capture the job PID and `kill -0` it instead of `pgrep`-ing the tool name.
  - `AGENT-PROMPT.md` is read from disk by the runtime (not baked into `bin/afk.mjs` — grep of the bundle for the section text returns nothing), so no bundle rebuild was needed.

---

## afk — native statusline + legacy bash orchestration removed (PRD #287)

- **status**: modified
- **upstream**: —
- **why**: The native TypeScript runtime (`src/apps/dev`) reached full parity with the bash orchestrator, the last gap being the Claude Code statusline, which was still bash-only. With a native `statusline` command in place, the entire legacy shell orchestration layer under `plugins/dev/skills/engineering/afk/scripts/` (and the `RED_AFK_LEGACY=1` escape hatch) is dead weight.
- **what changed**:
  - Added a native `statusline` command to the bundle. `commands/statusline.ts` does the IO (reads the Claude Code payload on stdin, resolves the project root from `$1` / payload / cwd, honours the `.red/config.yaml` `statusline: false` and `afk.statusline: false` opt-out, reads the git branch/detached-sha, aggregates live `.red/tmp/workers/*/*/afk.state.json` workers with the worktree diffstat fallback, and caches the gh `ready-for-agent`/`ready-for-human` counts for 60 s in `.red/tmp/statusline-cache.json`) and renders via the existing pure `core/statusline.ts`. Wired into `cli.ts` (`node bin/afk.mjs statusline "<root>"`). New `runtime/wire.ts#collectStatuslineAfk`, `runtime/git.ts#diffstatShortstat`, `runtime/gh.ts#countReadyForAgent/countReadyForHuman`. Tests: `tests/statusline-command.test.ts`, plus a `statusline` route case in `tests/cli-routing.test.ts`; `core/statusline.ts`'s tests stay green.
  - Deleted `plugins/dev/skills/engineering/afk/scripts/` entirely — all 86 `.sh` (the orchestrator `afk.sh`, `supervisor.sh`, `monitor.sh`, `statusline.sh`, `afk-reap.sh`, `hooks.sh`, `config.sh`, `once.sh`, `lib/*.sh`, and the 59 bash `*.test.sh`). KEPT `defaults/` (native hook-path scripts), `detectors/`, `examples/`, and all reference `*.md`.
  - Stripped the legacy delegation from the TS: removed `platform/legacy.ts` (`runLegacy`/`legacyScriptPath`/`LegacyCommand`/`scriptNames`) and the now-unused `platform/command.ts` (`runInteractive`); moved the surviving `skillDirFromModule` into `platform/skill-paths.ts`, re-anchored on `defaults/` (its old `scripts/afk.sh` anchor is gone); dropped the `RED_AFK_LEGACY` branches in `commands/run.ts`, `commands/monitor.ts`, and the `spawn("bash", supervisor.sh)` branch in `commands/fleet.ts`. Native is now the only path.
  - Repointed the statusline-wiring docs (`statusline/SKILL.md`, `setup-red-skills/SKILL.md`) from `bash …/scripts/statusline.sh` to `node "$CLAUDE_PLUGIN_ROOT/skills/engineering/afk/bin/afk.mjs" statusline "$CLAUDE_PROJECT_DIR"`, and removed the `RED_AFK_LEGACY` / "scripts remain present" transition notes from `afk/SKILL.md`.

---

## code-nav (mcp) — relocated into the monorepo (ADR 0034)

- **status**: modified
- **upstream**: —
- **why**: ADR 0034 splits plugin *definition* from *implementation* and ships one built bundle per artifact as a release asset fetched dynamically. The code-nav MCP server still lived under the plugin definition tree (`plugins/dev/mcp/code-nav`) with a committed `dist/index.js`, contradicting both principles.
- **what changed**: Moved the whole self-contained package `plugins/dev/mcp/code-nav` → `src/apps/code-nav` (relative imports unchanged). Build now emits a single minified bundle to the repo-root `dist/code-nav-mcp.bundle.min.mjs` (`esbuild --minify --target=node22` + the shared `createRequire` banner) instead of a package-local `dist/index.js`; the old `bin`/`prepare`/`start` scripts were dropped. `plugins/dev/.mcp.json` now resolves the bundle in order — dynamic-fetch cache (`<cache>/code-nav-<version>.bundle.min.mjs`), then repo-root `dist/code-nav-mcp.bundle.min.mjs`, then a clear failure. The dev `SessionStart` hook also fetches `code-nav` via `red-fetch.mjs`, and `red-release.yml` builds + publishes `code-nav.bundle.min.mjs` + `code-nav.manifest.json` as release assets. `plugins/dev/mcp/` no longer carries any source.

---

## start (engineering) — upstream CONTEXT-FORMAT.md drift skipped (no cherry-pick)

- **status**: modified
- **upstream**: `e3b90b5`
- **why**: Issue #259 — upstream advanced `0288510 → e3b90b5` with a single commit ("Refine rules in CONTEXT-FORMAT.md for clarity and consistency") touching only `grill-with-docs/CONTEXT-FORMAT.md`. That file is our `/start` skill's `CONTEXT-FORMAT.md` (renamed-from `grill-with-docs`), which has intentionally diverged.
- **what changed**: Reviewed the diff; took nothing. Upstream removed three rules our `/start` flow actively relies on — *Flag conflicts explicitly* (we emit "Flagged ambiguities"), *Show relationships* (cardinality), and *Write an example dialogue* — and reworded *Be opinionated* / loosened *Keep definitions tight* to "one or two sentences" where we already diverged to "One sentence max". Adopting the simplification would regress our grilling session. Same call as the prior drift (#195, bump to `0288510`), which also skipped this file's cosmetic tweaks. Bumped `.upstream` to `e3b90b5`; no skill content changed.

---

## afk afk-attempts grace-TTL cleanup for completed issues (modified)

- **status**: modified
- **upstream**: —
- **why**: Issue #258 (under PRD #244) — the **remote** side of completion cleanup, complementing the local sweep (#257). The `afk-attempts/{wid}/{N}-slug` snapshot branches that the failure-push net leaves on origin had no reaper: they accumulated on the remote forever, even for long-closed issues. They must survive a grace window after completion (so a reopened issue can still recover prior attempts) and then be deleted, while never touching a still-open issue's branches.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/lib/remote-branch.sh`: new `prune_completed_attempt_branches` lists `afk-attempts/*` on origin (`git ls-remote`), groups branches by the issue number in the ref, classifies each issue via `gh issue view --json state,closedAt`, and deletes every snapshot branch for issues closed longer than the grace window ago — leaving open issues, within-grace issues, and any issue it cannot classify (gh error / missing `closedAt`) strictly untouched. Defensive reader `_attempt_snapshot_grace_s` (`RED_AFK_ATTEMPT_SNAPSHOT_GRACE_S`, default 7d) falls back to the default on a typo and honours `0` as immediate deletion. Best-effort, always rc 0. Header note updated to record that this is the one reaper of the `afk-attempts/*` namespace.
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: wired `prune_completed_attempt_branches` into main boot, after `cap_issue_attempts` — at boot, never on the close path, so it can never block a completion.
  - `plugins/dev/skills/engineering/afk/scripts/tests/snapshot-grace-cleanup.test.sh` (new): 15 assertions with PATH-mocked `git`/`gh` — cross-worker delete past grace, within-grace survival, open-issue untouched, configurable grace (1y keeps all, 0 deletes immediately), typo grace falls back to default, best-effort tolerance of a failing delete, gh-error issue left untouched, empty-ref no-op, and a static guard that boot wires the prune.
  - `plugins/dev/skills/engineering/afk/SKILL.md`: new *Snapshot Branch Grace Cleanup (boot-time)* section documenting the grace window, the env knob, and the open/within-grace/past-grace classification.

## afk completion sweep: cross-worker prune of an issue's attempts + age/count cap (modified)

- **status**: modified
- **upstream**: —
- **why**: Issue #257 (under PRD #244) — the local-disk side of completion cleanup. The split teardown (#256) only drops the heavy worktree on close and retains the attempt dir for the orphan-sweep TTL, so a completed issue's retained dirs lingered across every worker that tried it. And nothing reclaimed the attempt dirs of an issue that *never* completes (blocked-forever retries), so disk leaked. This slice adds the completion-triggered cross-worker sweep plus an age/count cap fallback, both refusing to touch a live worker's active attempt.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: new `completion_sweep_issue <issue>` removes every attempt dir for a completed issue across all workers via `lib/worker-paths.sh`'s canonical `workers/*/<issue>-a*` glob (worktree first, reusing `iter_drop_worktree`); new `cap_issue_attempts` prunes attempt dirs over an age cap (`RED_AFK_ATTEMPT_TTL_S`, default 14d) or per-issue count cap (`RED_AFK_ATTEMPT_KEEP`, default 5, newest kept) with defensive env readers `attempt_ttl_s` / `attempt_keep`; shared guard `_attempt_dir_is_live` keeps both off any attempt whose own state file carries a live pid, and `_drop_attempt_dir` is the single removal helper. Wired the sweep into `process_issue`'s DONE path (after `fire_post_iteration`) and the cap into main boot (after `prune_orphans`).
  - `plugins/dev/skills/engineering/afk/scripts/tests/completion-sweep.test.sh` (new): 19 assertions against a real parent repo + linked worktrees under mktemp — cross-worker sweep, unrelated-issue survival, idempotent re-sweep, live-attempt skip, age cap, count cap, live-attempt-preserved-despite-age, plus a static wiring guard that the DONE path calls the sweep.
  - `plugins/dev/skills/engineering/afk/SKILL.md`: close step 11 now documents the completion sweep; new *Attempt Cap (boot-time)* section documents the age/count caps and their env knobs.

## afk reaper watches the agent lane + process cross-check (modified)

- **status**: modified
- **upstream**: —
- **why**: Issue #251 (under PRD #244, closes #243) — the slice that finally *wires* the reaper-signal predicate (#248) into the fleet supervisor and repoints liveness onto the clean agent lane (#250). Until now the passive stall detector and hard reaper keyed off `afk.log`, which the orchestrator heartbeat writes every minute — so a hung worker's log kept advancing and both the stall flag and the irreversible kill were masked (#243). And even once flagged, the kill fired on lane silence alone, so a worker sitting mid-`pnpm build`/`vitest` (silent on the agent lane but genuinely busy) would be reaped. This slice closes #243 end-to-end: a genuinely stalled worker is detected and reclaimed; a busy one is not.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/supervisor.sh`: sources `lib/reaper-signal.sh`; `poll_stall_detector` now reads liveness from the clean agent lane via the new `find_slot_agent_lane` (which, with `find_slot_iter_log`, delegates to the shared `find_slot_iter_dir` pid→dir lookup) instead of `afk.log`, so the heartbeat can no longer keep a stalled slot's mtime fresh. The hard-reap escalation is gated behind `reaper_signal_decide`: the supervisor samples the worker tree (`sup_active_descendant` matches a build/test executable from the overridable `REAPER_BUSY_CMD_RE` against `ps -o comm=`; `sup_tree_cpu` aggregates `%cpu` across the orchestrator pid + descendants via the guarded `sup_descendant_pids`) and only calls `reap_stalled_slot` when the predicate returns `kill` (idle past `RED_AFK_STALL_KILL_THRESHOLD_S` AND no active descendant AND flat cpu); a busy candidate logs a `🛡️ … deferring reap` line and is left alone. Header comment rewritten to document the agent-lane liveness signal and the kill gate.
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: `iter_open` now creates the agent lane empty (`: >> "$AGENT_LANE"`) at t0 alongside `afk.log`, so the supervisor has a liveness baseline from the start of the iteration — a worker that wedges before its first turn still ages past the stall/kill thresholds instead of reading "no log yet" forever.
  - `plugins/dev/skills/engineering/afk/scripts/tests/stall-detector.test.sh`: liveness fixtures rewritten to write/age the agent lane (afk.log kept fresh to prove the detector ignores it); adds a `find_slot_agent_lane` resolution assertion.
  - `plugins/dev/skills/engineering/afk/scripts/tests/stall-reaper.test.sh`: stages the agent lane (aged) alongside afk.log so `poll_stall_detector` still flags the slot, and stubs `sup_active_descendant`/`sup_tree_cpu` to "genuinely stuck" so the end-to-end kill path runs deterministically.
  - `plugins/dev/skills/engineering/afk/scripts/tests/stall-agent-lane.test.sh` (new): the #243 regression — 16 assertions covering (1) flagged from agent-lane silence while afk.log is fresh, (2) a stuck worker reaped past the kill threshold despite a fresh afk.log, (3) no reap while a build/test descendant is active, and (4) no reap while the worker tree shows non-trivial cpu.
  - `plugins/dev/skills/engineering/afk/SKILL.md`: the fleet-supervisor section now documents the detector keying off the agent lane (not `afk.log`/firehose) and the reaper's busy-vs-stuck gate.

## afk clean agent lane + firehose; heartbeat off the agent lane (modified)

- **status**: modified
- **upstream**: —
- **why**: Issue #250 (under PRD #244) — the first slice to actually *wire* the jsonl-log module (#246) into the orchestrator. Until now `afk.log` was the single per-iteration lane, interleaving the inner agent's output with synthetic heartbeat lines and orchestrator noise, so there was no clean place to read "what is the agent doing right now" and the heartbeat kept the only lane fresh enough to mask a hung worker (the root of #243). This slice adds two JSONL lanes *alongside* the existing `afk.log` (it deliberately does not move directories — that is a later slice): a clean single-writer **agent lane** that carries only the inner agent's output, and an **everything firehose** for forensics. The heartbeat now mirrors its vitals to the firehose and never touches the agent lane, so the agent lane is the true liveness signal.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/lib/agent-lane.sh` (new): the fanout that turns the runner's decoded per-turn stream (one JSON-encoded assistant turn per stdin line, as `jq -c` emits) into the three per-attempt sinks. `agent_lane_fanout <plain_log> <agent_lane> <firehose> [KEY=VALUE]...` echoes each decoded turn to stdout (so it is a byte-for-byte drop-in for the old `tee -a` final pipeline stage and the inner agent's captured `result`/sentinel is unchanged), appends the raw text to the back-compat `afk.log`, appends one `type=agent` envelope per turn to the clean agent lane via the single-writer `jsonl_log_append_agent` (which rejects synthetic types by contract), and appends the same turn to the firehose via the flock-serialised `jsonl_log_append_shared` (the firehose is multi-writer within an attempt). Blank lines and null/empty turns are skipped; always returns 0 so a logging failure can never break the runner pipeline. Sources `jsonl-log.sh` relatively when not already in scope, mirroring `attempt-ledger.sh`.
  - `plugins/dev/skills/engineering/afk/scripts/lib/heartbeat.sh`: `heartbeat_emit_once` gains an optional `<firehose> <worker> <issue> <attempt>` tail (back-compatible — the existing 4-arg call site still writes only the plain `afk.log` line). When a firehose is set, it mirrors the same vitals (stage, elapsed, cpu, rss, last_stream_line) as a `type=heartbeat` record through `jsonl_log_append_shared`, and **never** writes the clean agent lane. `heartbeat_start` reads `FIREHOSE`/`WORKER_ID`/`CURRENT_ISSUE`/`CURRENT_ATTEMPT` globals and threads them into the loop's emit.
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: sources `jsonl-log.sh` + `agent-lane.sh`; `iter_open` sets `AGENT_LANE=$ITER_DIR/agent.log.jsonl` and `FIREHOSE=$ITER_DIR/log.jsonl` (cleared wherever the iteration globals are zeroed); `run_claude`/`run_codex` replace their final `jq -rj … | tee -a "$log_target"` stage with `jq -c …text… | agent_lane_fanout "$log_target" "$AGENT_LANE" "$FIREHOSE" worker=… issue=… attempt=…`; a new `afk_firehose <type> <msg> [KEY=VALUE]…` helper (flock-serialised) writes the firehose's `hook` (in `run_lifecycle_hook`), `timing` (after `run_inner` returns), and `error` (in the runner-crash branch) records; `process_issue` mirrors its local `attempt` into a `CURRENT_ATTEMPT` global so the lanes/heartbeat stamp the right attempt.
  - `plugins/dev/skills/engineering/afk/scripts/tests/agent-lane.test.sh` (new): 11 assertions feeding the fanout JSON-encoded turns and asserting the stdout drop-in (preserves `result`), the back-compat plain-log text with newlines restored, one `type=agent` record per turn on the agent lane with identity stamped and embedded newlines preserved, valid `type=agent` JSONL on the firehose, and the robustness paths (blank lines skipped, empty sink paths skipped while the agent lane is still written, rc 0).
  - `plugins/dev/skills/engineering/afk/scripts/tests/heartbeat-loop.test.sh`: adds a firehose section — heartbeat writes exactly one `type=heartbeat` record carrying identity + stage + cpu/rss/elapsed vitals, never creates the agent lane, and the unchanged 4-arg call still writes only the plain `afk.log` line.

## afk attempt-ledger module — next-attempt number + restart context (added)

- **status**: added
- **upstream**: —
- **why**: Issue #249 (under PRD #244) — when the orchestrator is about to (re)spawn a worker on an issue it needs both the next attempt number and the context to restart informed rather than blind: the previous attempt's remote snapshot branch reference and its recorded failure reason. The attempt-first tree (`workers/<worker>/<issue>-a<attempt>/`) is owned grammar-only by `worker-paths.sh` (it builds/parses paths and returns canonical glob *patterns* as literal strings, never touching disk), so something must expand those globs against the real filesystem. This slice ships that FS-enumeration consumer as a tested library; wiring it into the spawn/handoff path is a later slice.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/lib/attempt-ledger.sh`: a new module that reads the attempt tree, delegating all path grammar to `worker-paths.sh` (sourced relatively when not already in scope). `attempt_ledger_next_number <root> <issue>` expands `worker_paths_issue_glob` against the FS, parses each hit back with `worker_paths_parse`, and echoes (highest existing attempt) + 1, or 1 on the first attempt; returns non-zero on a malformed identity. `attempt_ledger_prev_dir <root> <issue>` echoes the highest-numbered existing attempt directory, returning non-zero when there is no prior (the first-attempt signal). `attempt_ledger_context <root> <issue>` assembles a restart-context block (`prev-attempt`, `prev-snapshot-branch`, `prev-failure-reason`) from the previous attempt's directory, reading the read-only per-attempt marker contract — `snapshot-branch.ref` (one-line remote snapshot branch ref) and `failure.reason` (free-text recorded reason), both optional and written by the reap/envelope path in a later slice. Missing markers degrade to labelled `(none)` / `(none recorded)` placeholders rather than erroring, so a kill before either was written still yields a usable block. The `_attempt_ledger_highest` helper scopes a `nullglob` change to itself so the unexpanded pattern never leaks into the loop.
  - `plugins/dev/skills/engineering/afk/scripts/tests/attempt-ledger.test.sh`: 28 assertions building a real attempt tree under `mktemp` (the FS enumeration is exercised for what it is), covering next-number derivation (first attempt → 1, single prior → 2, numeric — not lexical — max across workers, per-issue independence, unseen issue → 1, junk dir with a non-numeric suffix ignored), the always-returns-0-on-valid / non-zero-on-malformed contract, previous-attempt directory selection (highest wins, empty + non-zero when none), and context assembly (branch + reason + attempt number, empty first-attempt context, graceful degradation for bare / partial / multi-line marker files).

## afk reaper-signal module — busy-vs-stuck liveness predicate (added)

- **status**: added
- **upstream**: —
- **why**: Issue #248 (under PRD #244) — the passive stall detector (`supervisor.sh`, `compute_stalled`) flags a worker whose agent lane has gone silent past a threshold, but silence alone is not death: a worker mid-`pnpm build` or mid-`vitest` writes nothing to the agent lane for minutes, and a hard reaper keyed off lane silence alone kills live work (cf. #243, where a heartbeat-poisoned firehose mtime defeated the existing kill). This slice ships the clean liveness decision as a tested pure library; wiring it into the supervisor reap path is a later slice.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/lib/reaper-signal.sh`: a new pure module (no `ps`/`pstree`, no filesystem, no globals) exposing `reaper_signal_decide <idle_s> <idle_threshold_s> <active_descendant> <cpu_pct> [<cpu_busy_pct>]`, which echoes `kill`/`no-kill` and always returns 0. The orchestrator owns the process-snapshot I/O and passes the gathered signals in as strings, so the decision stays unit-testable against fixed inputs. A worker is busy (no-kill) when, despite agent-lane silence, either an active build/test descendant exists (truthy `active_descendant`) or the worker tree shows non-trivial cpu (`cpu_pct >= cpu_busy_pct`, default 5%); it is stuck (kill) only when idle past the threshold AND no active descendant AND flat cpu. Ambiguity favours no-kill: cpu exactly at the busy line counts as busy, idle below the threshold never kills, and an unparseable threshold never kills (non-integer idle → 0, non-numeric cpu → 0). Helpers `_reaper_truthy`, `_reaper_is_uint`, `_reaper_is_num`, and the awk-based float-safe `_reaper_cpu_busy` keep the predicate pure text.
  - `plugins/dev/skills/engineering/afk/scripts/tests/reaper-signal.test.sh`: 37 assertions sourcing the module directly (no orchestrator globals, no `ps`/`pstree`), covering AC1 (active descendant outranks flat cpu, in its common spellings), AC2 (non-trivial/float cpu, cpu-at-line, custom busy line), AC3 (idle + no descendant + flat cpu → kill, falsy descendant spellings, trivial-but-flat cpu), the idle-vs-threshold and cpu-busy boundaries, the fail-safe paths (bad threshold / non-numeric idle / non-numeric cpu), the always-returns-0 contract, and the helper predicates.

## afk base-resolver module — lock-value > pinned branch > main precedence (added)

- **status**: added
- **upstream**: —
- **why**: Issue #247 (under PRD #244) — AFK bases each worktree on, and merges each item back into, a single branch, but three sources can name it (branch lock, issue/PRD pin, default) and the winning-source precedence had no single owner. This slice ships that decision as a tested pure library; wiring it into the merge path is a later slice.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/lib/base-resolver.sh`: a new pure module (no git, filesystem, or globals) exposing `base_resolve <lock_value> <pin_value> [<default_branch>]`, which applies the fixed precedence lock-value > pinned branch > `main` and always returns 0. Callers (the orchestrator) read the lock file (`lock-store.sh`, `lock_store_read`) and resolve the pin (`pin-reader.sh`, `pin_resolve`) themselves and pass both in as strings, so the precedence stays unit-testable against fixed inputs. An empty or whitespace-only argument counts as "not set" (via the `_base_is_set` predicate), so a non-empty lock always wins over any pin, else a non-empty pin, else the default (`main` when omitted/empty). Because `pin_resolve` already collapses "no pin" to `main`, passing its output as the pin value is safe.
  - `plugins/dev/skills/engineering/afk/scripts/tests/base-resolver.test.sh`: 17 assertions sourcing the module directly (no orchestrator globals), covering the full precedence matrix (lock beats pin / lock with no pin / lock over a `main` pin / pin when unlocked / neither → main / no args → main), whitespace-only inputs treated as unset, the explicit default override and its precedence, the always-returns-0 contract, and the `_base_is_set` predicate.

## afk jsonl-log module — uniform-envelope appender + flock + readers (added)

- **status**: added
- **upstream**: —
- **why**: Issue #246 (under PRD #244) — the AFK structured-logging slice. Lane writes (per-attempt and shared cross-worker) had no single owner for the envelope shape or the flock discipline; the only existing analog, `lib/history.sh`, is hard-bound to the terminal-event ledger schema. This slice ships a general, reusable lane logger as a tested library only; no orchestrator consumer is wired to it yet.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/lib/jsonl-log.sh`: a new pure module (clock is the only ambient input, like `lib/history.sh`) that owns the uniform JSONL envelope `{ts, lvl, worker, issue, attempt, type, msg, …extra}` in one place. `jsonl_log_append` does a plain `>>` for single-writer per-attempt lanes; `jsonl_log_append_shared` does the identical write under `flock 9` for many-writer shared lanes so concurrent workers never interleave a line (same discipline as the afk-history ledger). `jsonl_log_append_agent` stamps `type=agent` and rejects any attempt to write a synthetic/orchestrator record type, enforcing by contract that the agent lane carries only agent output. `jsonl_log_filter_worker` / `jsonl_log_filter_type` are jq-`select` readers that return matching records in file order (missing file → rc 1, silent, so the caller renders its own empty state). Validation refuses missing required args (rc 2), non-numeric issue/attempt, and reserved (`ts`/`type`/`msg`) or ill-formed extra keys (rc 3), and jq-escapes a `msg` carrying quotes/newlines/JSON metacharacters into exactly one valid line — malformed input never corrupts a lane.
  - `plugins/dev/skills/engineering/afk/scripts/tests/jsonl-log.test.sh`: 49 assertions covering envelope shape (every standard field, JSON types, canonical key order, defaults, auto-created parent dir), malformed-input rejection and the nasty-`msg` round-trip, concurrent-append integrity (40 parallel shared-lane writers → 40 lines, each independently valid JSON, all payloads distinct), the agent-lane synthetic-type contract, and both readers (file order, no-match rc 0, missing-file rc 1).

## afk worker-paths module — own the workers/{wid}/{issue}-a{n} scheme (added)

- **status**: added
- **upstream**: —
- **why**: Issue #245 (under PRD #244) — the first slice of the AFK worker/attempt directory restructure. The new attempt-first layout `.red/tmp/workers/{wid}/{issue}-a{n}/` needs a single owner so the path format lives in one place instead of scattered string literals across the six consumers PRD #244 enumerates (story 26). This slice ships that owner as a tested library only; no consumer is wired to it yet.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/lib/worker-paths.sh`: a new pure-text module (no `gh`, git, or filesystem access) that builds an attempt directory path from a `(worker, issue, attempt)` identity (`worker_paths_build`), parses the identity back out of a path round-tripping with the builder (`worker_paths_parse`), and exposes the two canonical globs the rest of the system needs — all attempts of one issue across every worker (`worker_paths_issue_glob` → `…/workers/*/<issue>-a*`) and all live workers (`worker_paths_workers_glob` → `…/workers/*`). Globs are returned as literal patterns, not expanded, so the surface stays unit-testable. Validation rejects malformed identities predictably: worker ids must be a single `[A-Za-z0-9_-]` segment (no slashes), issue/attempt must be positive integers with no sign or leading zeros; parse derives the leaf as `<issue>-a<attempt>`, the worker from its parent, and requires the grandparent segment to be exactly `workers`, so it is independent of root depth.
  - `plugins/dev/skills/engineering/afk/scripts/tests/worker-paths.test.sh`: 30 assertions covering build (happy path, trailing-slash normalisation, and eight malformed-identity rejections), parse (depth-independence, trailing slash, and six non-matching-path rejections including a `worktree/` subdir), a four-identity round-trip, and both globs verified twice — as literal patterns and expanded against a fixture worker tree to confirm they select exactly the right directories.

## memory attempt.hooks summary field from Envelope (added)

- **status**: added
- **upstream**: —
- **why**: Issue #216 (under PRD #207) — sixth slice of the AFK terminal-envelope work, the Memory follow-up to #215. The AFK terminal Envelope now lists every user-declared lifecycle hook that ran during the issue's lifecycle (`<lifecycle_name> <command> exit=<rc>`), but recall consumers asking *"what filter did this attempt run with?"* still had to re-fetch and re-parse the raw issue comment. Carrying the same triples on the `attempt` node as a graph property closes that loop without any new node types or edges — recall already returns the attempt; now it answers the hook question directly from the node properties.
- **what changed**:
  - `plugins/memory/src/reasoning/attempt-writer.ts`: introduces an `AttemptHookRecord` interface (`{lifecycle, command, exit_code}`) and an optional `hooks?: AttemptHookRecord[]` field on `ReasoningAttemptPayload`. A new `normaliseHookRecords` helper trims strings, accepts numeric or `/^-?\d+$/` string exit codes, and drops entries missing any of the three required fields — half-filled triples never reach the graph. The writer sets `properties.hooks` only when the normalised array is non-empty, so a project with no user hooks declared produces an `attempt` node *without* the property (consistent with the "absent vs empty array" choice called out in the issue acceptance criteria).
  - `plugins/memory/src/graph-recall.ts`: extends `GraphRecallHit` with an optional `hooks?: GraphRecallHookEntry[]` field, plumbed through `graphRecallResult` by reading the candidate node's `properties.hooks` through a defensive `extractHookEntries` (mirrors the writer's normalisation, so a node written by an older code path with malformed entries never crashes recall). Field is absent on every non-attempt hit and on attempt hits with no hooks.
  - `plugins/memory/src/engine.ts`: `renderContext` (the `RecallResult.context_md` builder, shared by CLI/MCP/HTTP) appends one line per attempt node carrying hooks in the form `_hooks: pre_pick=0, post_pick=1_`. The line sits under the existing summary line so the existing recall layout stays stable; entries with malformed lifecycles are silently dropped via the same `renderAttemptHooks` helper.
  - `plugins/memory/src/cli.ts`: `memory recall` prints a third indented line (`hooks: pre_pick=0, post_pick=1`) under each attempt hit that carries the field; non-attempt hits and attempts without hooks are unchanged.
  - `plugins/memory/src/mcp-server.ts`: the `memory_recall` MCP tool response includes the `hooks` array on each node entry that has it, via the same `extractMcpHookEntries` defensive parser. Keeps the absent-vs-empty contract the writer enforces.
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: adds `afk_hooks_log_records_json` which converts the iteration's `HOOK_EXECUTIONS_FILE` (tab-separated `lifecycle\tcommand\texit_code` triples, the source-of-truth the dispatcher writes — *not* the human-rendered `name cmd exit=rc` text the Envelope emits, which loses fidelity for commands with spaces) into a JSON array via an `awk` JSON-escaper piped through `jq -cs`. `afk_memory_record_terminal_attempt` takes an optional 14th argument `hooks_log_file` defaulting to `$HOOK_EXECUTIONS_FILE`, runs the converter into a slurpfile, and merges the array into the payload as `hooks` only when non-empty (jq `if … length > 0 then {hooks: …} else {} end`) — preserves the existing "absent property" contract and stays consistent with the writer's behaviour. Malformed file, missing file, missing `jq`, or any malformed line all collapse to `[]` so the caller drops the property entirely; the rest of the payload still posts.
  - `plugins/memory/tests/reasoning-attempt.test.ts`: adds two integration tests against a real RedDB store — one asserts the field passes through the writer with malformed entries dropped, undefined input produces no property, and an explicit empty array also produces no property (the absent-vs-empty contract); the second asserts the recall surfaces — both the CLI `GraphRecallHit.hooks` array and the `context_md` rendered line — include the hooks when present, so the contract holds end-to-end through the recall path actually exercised by `/memory:recall` and MCP.
  - `plugins/dev/skills/engineering/afk/scripts/tests/memory-attempt.test.sh`: adds six parser-level assertions (valid records, first lifecycle, second exit code, malformed lines dropped, empty file → `[]`, missing file → `[]`) and a payload-shape pair — one verifies the existing `done` payload omits `.hooks` entirely when `HOOK_EXECUTIONS_FILE` is unset (the default case for projects with no `afk.hooks` block), and the second runs `emit_envelope` with `HOOK_EXECUTIONS_FILE` pointed at a populated log and asserts the resulting Memory payload carries the hooks array with the original command spaces preserved (would have regressed if the parser used the human-rendered Envelope hook section instead of the dispatcher's TSV).
  - `.red/contexts/memory/CONTEXT.md`: adds a *Reasoning attempt hooks* glossary entry (typed property, populated best-effort, absent vs empty contract) and a matching relationship line under the existing **Reasoning attempt** ↔ **Validation node** relationships so the new field is enumerated alongside the rest of the attempt schema.
  - `CHANGES.md`: this entry (added).
- **compatibility**: additive everywhere. ADR 0017's "Memory plugin failures do not block the Envelope post" contract is preserved — the AFK side wraps the converter in defensive defaults and the `memory_record_attempt` bridge already swallows write errors. Projects without an `afk.hooks` block see no property change on existing `attempt` nodes (the writer drops the field when the normalised array is empty). Existing `attempt` nodes recorded by older AFK code paths simply lack the property; the recall surfaces gate every render path on `Array.isArray(hooks)` so an old node never crashes the new render. The Envelope bytes are not touched by this slice — the hook section visible on GitHub is the same shape as #215 shipped.

---

## memory MEMORY.md migration from harness to repo (added)

- **status**: added
- **upstream**: —
- **why**: Issue #220 (under PRD #217) — the Memory closed-loop slice that pulls governance auto-memory into the repo. Today `MEMORY.md` and its per-fact files live at `~/.claude/projects/<project-slug>/memory/`, which is per-machine and per-user — a new contributor cloning red-skills has no visibility into the project rules (English-only, kebab-case labels, AFK stall semantics, `red-` workflow-prefix rule) until they violate them. This slice ships those rules in the clone and leaves a symlink at the old harness path so the Claude Code system-prompt loader keeps resolving the same content without harness changes.
- **what changed**:
  - `scripts/memory-migrate-from-harness.sh`: one-shot migration that moves the harness directory into `<repo>/.red/memory/MEMORY.md` plus `<repo>/.red/memory/memory/<slug>.md` per fact, rewriting bare per-fact links inside `MEMORY.md` (`](feedback_x.md)` → `](memory/feedback_x.md)`) so the index resolves under the new layout, then replaces the harness directory with a symlink pointing at `<repo>/.red/memory`. Idempotent on every replay path: (a) when the harness is already a symlink resolving to the repo target, the script prints `already migrated, no-op` and exits 0 without touching any file; (b) on a fresh clone (`MEMORY.md` already present in-repo from git, harness is still a real dir) the script installs the symlink without overwriting the in-repo content and never salvages from the harness side — guards against a stale `MEMORY.md` left behind by an aborted previous attempt silently shadowing the versioned copy. Defaults are correct for the standard layout (`$HOME/.claude/projects`, `git rev-parse --show-toplevel`, slug derived by replacing `/` with `-` in the absolute repo path); the three flags `--harness-root`, `--repo-root`, `--project-slug` exist so the test fixtures can drive the script in a tmpdir without touching the user's real `~/.claude`.
  - `scripts/test-memory-migrate-from-harness.sh`: 15-assertion sandboxed test that builds a fake harness + repo in a tmpdir on every run (never touches `~/.claude`), covering the explicit acceptance grid — fresh-repo migration moves files into the new layout, bare per-fact links are rewritten, the harness path becomes a symlink whose `readlink -f` resolves to the repo target, the symlink read from the harness side returns the same bytes as the repo side (the system-prompt-loader contract), idempotent re-run prints `already migrated, no-op` and leaves repo files byte-identical by sha256sum (regression-guards against a partial re-copy silently mutating tracked content), the symlink survives the no-op replay, the fresh-clone replay branch installs the symlink without overwriting the in-repo content even when the harness has a stale `MEMORY.md` left behind.
  - `.red/memory/MEMORY.md`: the migrated index, with the link rewrite already applied so the file lands in its committed shape rather than relying on the script to rewrite tracked content on next run. Lists the six current governance entries (workflow prefix, label naming, English-only repo, Codex hooks reference, AFK stall enforcement, AFK stall false negatives).
  - `.red/memory/memory/feedback_red_workflow_prefix.md`, `feedback_label_naming.md`, `feedback_repo_english_only.md`, `feedback_afk_stall_enforcement.md`, `feedback_afk_stall_false_negatives.md`, `reference_codex_hooks.md`: the six per-fact files moved verbatim from the harness layout. Frontmatter (`name`, `description`, `metadata.type`) is preserved unchanged so the harness's loader contract still matches.
  - `.red/agents/memory.md`: documents the new layout, the harness symlink contract (`~/.claude/projects/<slug>/memory` → `<repo>/.red/memory`), how to add a new memory fact (create the per-fact file, append one index line, commit both in the same change so the index never drifts), and the explicit separation between auto-memory (human-curated, versioned) and the graph store (machine-curated, gitignored operational state) that lives next to but not inside the auto-memory layout.
  - `CHANGES.md`: this entry (added).
- **compatibility**: the graph-mode memory under `.red/memory/{graph.rdb*,sessions/,*.log,*.cache*}` is gitignored operational state and is untouched by this slice. The auto-memory layout (`MEMORY.md` plus `memory/`) is a separate surface — the two coexist in the same directory but are independent. The migration is one-way (harness → repo); reversing it would mean copying the repo content back to the harness path and removing the symlink, but no such workflow is supported because the per-machine state is the wrong scope by design (the whole point of this slice).

---

## memory wiki extract on PR merge (added)

- **status**: added
- **upstream**: —
- **why**: Issue #219 (under PRD #217) — first PR-merge slice of the Memory closed-loop. Today the wiki index is 60 bytes and grows only when an operator remembers to run `/wiki ingest`, so merged decisions never become wiki entries. This slice closes the loop on the GitHub side: every merged PR auto-publishes a `source`-type wiki page to `main` so the wiki becomes a journal of merged decisions. Graph ingestion stays out of scope by PRD decision (would need a remote RedDB endpoint or shipping the binary store through git); the local `PostToolUse` hook will own that side of the loop in a later slice.
- **what changed**:
  - `.github/workflows/red-memory-wiki-extract.yml`: new workflow fired by `pull_request.closed`, gated at the job level with `if: github.event.pull_request.merged == true` so an un-merged close never runs the extractor. Declares `contents: write` explicitly (it pushes back to `main`) and `pull-requests: read` (it reads PR body/commits/files via `gh pr view`). Concurrency group keyed by PR number, `cancel-in-progress: false`, so a fast re-run for the same PR queues rather than aborts the previous push. Checks out `ref: main` with `fetch-depth: 0` and the GitHub token (the default checkout would be detached at the merge SHA, which is the wrong base for a back-push). Calls `scripts/memory-wiki-extract-from-pr.sh` then `scripts/memory-wiki-regen-index.sh`, force-adds the two auto-generated paths (`.red/wiki/pages` and `.red/wiki/index.md`) because `.red/wiki/` is gitignored to keep local manual wiki notes private (auto-generated content opts in explicitly via `git add -f`), commits with the marker `[memory] wiki extract for #<pr>`, and skips the push when the staged diff is empty so a no-op re-run does not pollute history.
  - `scripts/memory-wiki-extract-from-pr.sh`: deterministic template-based page generator. Accepts `--pr-number`, `--pr-data <path-to-json>` (a JSON file matching `gh pr view --json title,body,author,mergeCommit,url,files,commits`), and an optional `--wiki-root` (default `.red/wiki`). Slugifies the PR title with the conventional kebab-case rule (lowercase, `[^a-z0-9]+` → `-`, trimmed, capped at 60 chars). Writes a `type: source` page at `pages/<pr>-<slug>.md` with frontmatter (`title`, `tags: [pr, merged]`, `created`, `updated`, `sources: [pr-<n>]`, `pr`, `merge_sha`) and three body sections (Summary from the PR body, Commits from `messageHeadline`, Files changed from `files[].path`). **Idempotency:** removes any existing `pages/<pr>-*.md` before writing, so a re-run after a PR-title rename leaves no stale page behind. Network-free and graph-free by construction — only file I/O on the wiki root and `jq` over the supplied JSON.
  - `scripts/memory-wiki-regen-index.sh`: regenerates `<wiki-root>/index.md` from `<wiki-root>/pages/*.md`. Parses each page's frontmatter via `awk` (no YAML dependency), buckets by `type:` field (`source` / `entity` / `concept` / `synthesis`, with `comparison` folded into synthesis per the wiki agent's type taxonomy), and emits an alphabetised `[title](./pages/<slug>.md)` list per bucket. Empty buckets render the canonical hint text from `wiki-init/index-template.md` (so the regenerated index matches what `/wiki-init` would have produced on a fresh wiki). Pages with an unrecognised type fall into an "Other" section that is omitted when empty — keeps the index honest about leakage without forcing an "Other" header on every regen.
  - `scripts/test-memory-wiki-extract.sh`: 27-assertion fixture-based test covering the explicit acceptance grid — kebab slug + frontmatter contract on first extraction, idempotent re-run with same title leaves exactly one page, idempotent re-run with a renamed title removes the old slug and writes the new one (exactly one page survives), index regen lists the surviving page and omits the removed slug, and the workflow YAML declares the `pull_request.closed` trigger, the `merged == true` gate, the `contents: write` permission, the `[memory] wiki extract for #` marker string, the `red-` filename prefix, and contains no `memory ingest|extract|recall|store` invocation and no `graph.rdb` reference (the wiki-only / graph-free contract from the PRD).
  - `scripts/fixtures/memory-wiki-extract/pr-100.json`, `pr-100-renamed.json`: minimal PR-data fixtures (matching the `gh pr view --json` shape the workflow consumes) covering the first-merge case and the same-PR-renamed-title case.
  - `CHANGES.md`: this entry (added).

---

## afk terminal envelope — record user hooks executed (added)

- **status**: added
- **upstream**: —
- **why**: Issue #215 (under PRD #207) — fifth AFK terminal-envelope slice. Today's Envelope reflects what the worker saw and did, but not the **policy** that shaped it: a queue mutation in `post_pick` (e.g. `only-mine`), a guard in `pre_merge`, or a custom validator in `post_merge` is invisible to the reviewer reading the issue comment. This slice surfaces every user-declared lifecycle hook that ran during the issue's lifecycle, with its lifecycle name, command, and exit code, in execution order. Built-in defaults (`cargo`, `gradle`, `heartbeat`, `envelope`, `validation`) are deliberately excluded — they are skill-owned and noisy, and the new section is meant to surface operator intent rather than the skill's own machinery. The captured data also seeds the follow-up Memory `attempt.hooks` field tracked in #216.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/lib/hook-dispatcher.sh`: adds a parallel `HOOK_KINDS[<name>]` newline-joined list and a `HOOK_REGISTER_KIND` env-var contract (default `user`) read by `hook_register` so every registered command is tagged `default` or `user` at registration time. The dispatcher reads kinds in lockstep with cmds; after each command runs (any rc, including the `abort`-policy non-zero that short-circuits the rest of the chain), the offender is recorded via the new internal `_hook_executions_record` helper when its kind is `user`. The recorder maintains both an in-memory `HOOK_USER_EXECUTIONS` array (used by unit tests under direct calls) and an on-disk append-only log at `$HOOK_EXECUTIONS_FILE` when set — the file is the source of truth across the `$(hook_dispatch …)` capture sites the orchestrator uses for `pre_session` / `pre_pick` / `post_pick` / `pre_worktree` / `pre_worker`, where the array would be lost to subshell isolation. Adds `hook_executions_reset` (truncates the file and clears the array — called by the orchestrator at every iteration boundary) and `hook_executions_dump <file>` (renders the deterministic `<lifecycle_name> <command> exit=<rc>` shape one per line, reading from the file when set and falling back to the array otherwise; prints the line count on stdout for caller detection of empty).
  - `plugins/dev/skills/engineering/afk/scripts/lib/hook-config.sh`: registers every built-in default (`cargo`, `gradle`, `heartbeat`, `envelope`, `validation`) with `HOOK_REGISTER_KIND=default` so they are excluded from `HOOK_USER_EXECUTIONS` even when they share a lifecycle point with a user hook. The kind binding is scoped per `hook_register` call (env-var binding on the same line as the call) to avoid leaking into the user-hook replay block. The state-reset at the top of `hook_config_load` now clears `HOOK_KINDS` alongside `HOOK_LISTS` so successive loads do not leak kind metadata.
  - `plugins/dev/skills/engineering/afk/scripts/lib/envelope.sh`: extends both `envelope_emit_attempt` and `envelope_emit_done` with a new `hooks_file=<path>` argument that, when set and non-empty, appends a `data-section="hooks"` block to the rendered Envelope. The block sits **last** in every status (after `notes` / `diff` / `log` / `validation`) so existing section-order tests (`notes < diff < log`) stay green. The supervisor's `discarded` adapter is deliberately untouched — discards record a slot-park decision above the per-issue lifecycle, so no per-issue hook chain exists to enumerate. Empty `hooks_file` (no user hooks ran in this iteration — the common case for projects without an `afk.hooks` block) is treated identically to omitted: no section emitted.
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: `iter_open` now exports `HOOK_EXECUTIONS_FILE="$ITER_DIR/hooks-executed.log"` and calls `hook_executions_reset` so the recorder scope is exactly the iteration — the file is torn down with `ITER_DIR` on every terminal outcome (success or failure). `emit_envelope` dumps the recorded executions to a temp file via `hook_executions_dump`, only attaches `hooks_file=` when the dump is non-empty (defensive: falls through to "no section" when the dispatcher is not in scope, e.g. under future test harnesses that source only the envelope module), and removes the temp file after the Module returns. The `done` / `blocked` / `no-sentinel` / `merge-conflict` `emit_envelope` call sites are untouched — the orchestrator does not need to know about the new section because it is computed centrally.
  - `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-hooks-executed.test.sh` (new, 33 assertions): covers the explicit acceptance grid — (1) empty hook list produces zero executions, (2) a single user hook is recorded with its lifecycle name + command + `exit=0`, (3) multiple user hooks at the same lifecycle point are recorded in execution order with their actual exit codes (including the `policy=continue` `false`/rc=1 case), (4) mixed defaults+user only records the user hook (defaults excluded), (5) non-zero exit (`exit 42`) is preserved in the line, not omitted, (6) the abort-policy `pre_session` chain still records the offender that triggered the abort but does NOT record the post-failure commands that were short-circuited, (7) the file-backed recorder survives the `$()` subshell capture used by `pre_session` (the canonical site that would lose array state), (8) `hook_executions_reset` clears the file across iterations, (9) the envelope module renders the section with the `<details data-section="hooks">` tag, lists every recorded execution in order, omits the section entirely on an empty file, and places `hooks` after `diff` in the failure-family envelope (regression-guards the section-order tests), (10) `iter_open` wires `HOOK_EXECUTIONS_FILE` inside `ITER_DIR` and resets `HOOK_USER_EXECUTIONS` to empty, and (11) the built-in defaults registered via `hook_config_register_defaults` carry `kind=default` in `HOOK_KINDS` (test tolerates environments where defaults are not installed).
  - `plugins/dev/skills/engineering/afk/SKILL.md`: extends the *Terminal-Event Envelope* section with a new paragraph explicitly documenting the `data-section="hooks"` block — that it appears on every terminal Envelope (`blocked`, `no-sentinel`, `merge-conflict`, `done`) whenever at least one user-declared hook ran, that built-in defaults are excluded by design, the deterministic line shape `<lifecycle_name> <command> exit=<rc>`, the execution-order ordering across the entire lifecycle (`pre_session` through `post_session` / `on_session_error`), that non-zero exits are listed with their exit code (never omitted), that empty hook lists produce no section rather than an empty one, and that the `discarded` supervisor envelope never carries the section because discards live above the per-issue lifecycle.
- **compatibility**: additive only. Projects with no `afk.hooks` block in `.red/config.yaml` see no behaviour change — no user hooks register, the executions log stays empty, and the Envelope is byte-for-byte identical to the previous shape. Projects with existing `afk.hooks` declarations gain the new section without any config change. The `HOOK_REGISTER_KIND` env contract defaults to `user`, so any third-party caller of `hook_register` that does not opt in keeps its hooks visible in the Envelope (the safer default — a typo in a future default-registration site cannot silently hide hooks from the operator). The `HOOK_EXECUTIONS_FILE` env var is scoped to `ITER_DIR`, so cross-iteration leakage is impossible. The file is best-effort: a write failure (full disk, permissions) does not abort the dispatcher; the Envelope simply renders without the section in the failure case, matching the existing `notes_file` / `log_file` failure modes.

---

## afk lifecycle hooks — on_session_error last-gasp (added)

- **status**: added
- **upstream**: —
- **why**: Issue #214 (under PRD #207) — fourth AFK lifecycle slice. Wires `on_session_error` as the last-gasp hook that fires when the AFK loop itself crashes (unhandled `set -e` kill of the orchestrator, supervisor death, unrecoverable orchestrator exception). Distinct from `on_worker_error` (a single worker crashed; the loop continued) and from `post_session` (clean shutdown). This is the only path that guarantees a notification when the autonomous worker stopped without the operator noticing — the demo case from the PRD is a PagerDuty / Slack pager that fires with enough context for the operator to triage.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: defines `_afk_on_session_error_handler` and the `AFK_SESSION_CLEAN_EXIT=0` sentinel above the source guard (so test harnesses that `source afk.sh` can drive the handler), then installs the `trap _afk_on_session_error_handler EXIT` immediately after the source guard (so sourcing does not arm a trap in the calling shell). The handler checks the sentinel first; on `AFK_SESSION_CLEAN_EXIT=1` it returns 0 (no dispatch). It also returns 0 on `$?` = 0, on a missing `hook_dispatch` (early-boot failure before lib sourcing — defensive only), and after every dispatch. The dispatch path exports `RED_AFK_ERROR_CLASS` (default `session-crash`), `RED_AFK_WORKSPACE`, `RED_AFK_RUNNER`, and `RED_AFK_ERROR_MESSAGE`, builds `{runner, worker_id, workspace, error:{class, rc, message}}`, and routes through the existing dispatcher (`hook_dispatch on_session_error`, policy `continue` already declared in `lib/hook-dispatcher.sh` by #208). The handler always returns 0 so a failing hook cannot block the process from terminating with its original rc. Marks every intentional exit clean by setting `AFK_SESSION_CLEAN_EXIT=1` before the `exit`: the `cleanup` trap (INT/TERM, rc=130), the `pre_session` abort (`exit "$_rc"`), the `hook_config_load` failure (`exit "$_rc"`), the straggler "aborted by user" branch (`exit 0`), the `on_idle` clean drain (`exit 0`), and the end-of-script post_session site (no explicit exit — sentinel set right after the `post_session` dispatch and before the final `NO MORE TASKS` echo). The legacy `cleanup` trap and the existing `on_worker_error` branch are untouched — per-worker crashes still return 0 from `process_issue` and never propagate to the EXIT trap, so `on_session_error` does not fire for them. Quota exhaustion (`exit 75` inside `process_issue`'s `RUNNER_EXHAUSTED` branch) is deliberately NOT marked clean — the worker has stopped and the operator may want a pager, which is exactly the demo case.
  - `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-on-session-error.test.sh` (new, 36 assertions): covers (1) wiring (exactly one `hook_dispatch on_session_error` site, exactly one `trap _afk_on_session_error_handler EXIT`, the sentinel + handler defined above the source guard), (2) the handler's structural contract (exports `RED_AFK_ERROR_CLASS`, defaults the class to `session-crash`, honours the sentinel, always returns 0), (3) dispatcher policy (`on_session_error=continue`) and canonical-name membership, (4) handler end-to-end against a registered hook on a simulated crash (`( exit 42 )` → handler dispatches, ctx carries `error.{class:session-crash, rc:42}`, `RED_AFK_ERROR_CLASS` is exported), (5) sentinel suppression (no dispatch when `AFK_SESSION_CLEAN_EXIT=1` even with rc=7), (6) rc=0 suppression (no dispatch even without sentinel — defensive), (7) `on_worker_error` branch returns 0 / does not `exit` so per-worker crashes never propagate to the session handler, (8) failing user hook (exit 99) does NOT block the process exit (handler still returns 0), (9) every known intentional exit (cleanup trap, pre_session abort, hook_config_load failure, straggler decline, on_idle exit, end-of-script post_session site) sets `AFK_SESSION_CLEAN_EXIT=1` before the `exit`, and (10) SKILL.md documents `on_session_error`, the `session-crash` class, the distinction from `on_worker_error` / `post_session`, that non-zero is logged, and that the process still exits.
  - `plugins/dev/skills/engineering/afk/SKILL.md`: extends the *Lifecycle Hooks* table with the `on_session_error` row carrying the env contract (`RED_AFK_ERROR_CLASS` default `session-crash`, `RED_AFK_ERROR_MESSAGE`), the immutable slice (`error:{class, rc, message}` — none mutable because the loop is already collapsing), and the explicit "non-zero is logged but the process still exits — this hook cannot rescue the session, only announce its death" exit-code policy. The When-it-fires column carries the distinction from `on_worker_error` and `post_session` directly, plus the explicit "Does NOT fire on a user-requested abort (`pre_session` rejection, straggler decline, Ctrl+C / SIGTERM through the cleanup trap) — those set the clean-exit sentinel before exiting" so hook authors know exactly when they will and will not be paged.
- **compatibility**: additive only. No existing hooks change semantics. The handler is best-effort: when `hook_dispatch` is not yet sourced (e.g. an early-boot failure before lib sourcing) the handler is a no-op, so the trap can never make the original failure worse. The default class is `session-crash`; a user hook can read `RED_AFK_ERROR_CLASS` to distinguish from `runner-crash` (the `on_worker_error` class). Cleanup paths (INT/TERM, pre_session abort, straggler decline) are marked clean by design — the PRD explicitly separates the "operator intervention" path (cleanup) from the "supervisor died without operator noticing" path (`on_session_error`).

---

## afk lifecycle hooks — pre_merge / post_merge + validation post_merge default (added)

- **status**: added
- **upstream**: —
- **why**: Issue #213 (under PRD #207) — third AFK lifecycle slice. Wires `pre_merge` (before `git merge --no-ff`, mutable `{issue, workspace, diff}`, abort-on-non-zero so a user guard can reject a diff over a size threshold) and `post_merge` (after the push succeeds, mutable `{issue, workspace, merge_commit}`, continue policy because the merge has already landed). Registers the CI/smoke validation re-run as a built-in `post_merge` default that runs before any user `post_merge` hook, so a Slack notifier reading `result.validation_status` sees the outcome reconciled into the context.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: dispatches `pre_merge` inside `do_merge`, immediately after the legacy `run_lifecycle_hook pre-merge` (kept for the three-layer detector model in `hooks.sh`) and before `pre_merge_sha` is captured — computes `git -C "$PROJECT_ROOT" diff "$merge_base" "$branch"`, exports `RED_AFK_WORKSPACE` (= `$PROJECT_ROOT`) and `RED_AFK_MERGE_BASE`, and builds `{issue:{number,title}, workspace, branch, diff}`. Non-zero from the chain restores the primary branch (when switched) and returns 1 from `do_merge` — `process_issue`'s existing merge-conflict envelope path then flips the issue to `ready-for-human`, which is the brief's "surfaces as a worker failure" outcome. Dispatches `post_merge` after the push, immediately after the legacy `run_lifecycle_hook post-merge` — exports `RED_AFK_MERGE_COMMIT` (full sha), `RED_AFK_MERGE_SHA` (short sha) and `RED_AFK_WORKSPACE`, builds `{issue:{number,title}, workspace, merge_commit:{sha, short}}`. The chain rc is logged-and-continued (policy `continue` already declared in `lib/hook-dispatcher.sh` by #208) because the push has already landed on origin; rolling back over a hook failure would risk the worker-branch / origin invariants in ADRs 0008 / 0015.
  - `plugins/dev/skills/engineering/afk/scripts/lib/hook-config.sh`: extends `hook_config_register_defaults()` with the `validation` `post_merge` default, gated by `HOOK_DEFAULTS_DISABLED[validation]` set from `afk.hooks.defaults.validation: false`. Same defaults-first ordering as #211/#212 — user `post_merge` hooks always run after the default.
  - `plugins/dev/skills/engineering/afk/defaults/validation-post-merge.sh` (new, executable): reads ctx from stdin and the merged primary checkout from `RED_AFK_WORKSPACE`; runs `pnpm -s test|typecheck|lint|build` at the workspace root for each script that exists in `package.json`. Mutates the ctx to attach `result.{validation_status, validation_summary}` (statuses are `passed` / `failed` / `skipped`; the summary is the one-line `test:✓ typecheck:skip lint:✗ build:skip`-style string the inline pre-merge `feedback()` step already emits in iteration logs, kept stable so a user hook parsing it doesn't break). Always exits 0 — the merge has already landed, so the dispatcher's `continue` policy is reinforced by the default itself. Skipped (status=`skipped`) when no workspace or no `package.json`.
  - `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-pre-post-merge.test.sh` (new): 47-assertion suite covering wiring (exactly one of each dispatch, `pre_merge` before `git merge --no-ff`, `post_merge` after the push), the pre_merge ctx shape and env exports including the diff, the post_merge ctx shape and `RED_AFK_MERGE_COMMIT`/`RED_AFK_MERGE_SHA` exports, dispatcher policies (`pre_merge=abort`, `post_merge=continue`) and canonical-name membership, defaults file existence + executability, defaults-first ordering at `post_merge` (validation + 2 user hooks = 3 cmds, default first), `defaults.validation: false` opt-out leaves only the user hook, missing config still registers the validation default, validation default end-to-end across the four states (no `package.json` → skipped, passing script → passed, failing script → failed but rc=0, no workspace → skipped) with ctx `merge_commit` preserved through the mutation, continue policy on a failing user `post_merge` hook (rc=0 round-trips, failure logged), abort policy on a failing `pre_merge` hook (rc propagated, failure logged), and SKILL.md coverage of both hooks, the validation default's disable toggle, the `RED_AFK_MERGE_COMMIT` / `RED_AFK_MERGE_BASE` env contracts, and the "mechanism between pre/post, never dispatched as a hook" invariant (ADR 0008).
  - `plugins/dev/skills/engineering/afk/SKILL.md`: extends the *Lifecycle Hooks* table with `pre_merge` and `post_merge` rows. `pre_merge` row carries the env contract (`RED_AFK_MERGE_BASE`), the mutable slice `{issue, workspace, diff}`, the `branch` read-only context, and the abort policy with the explicit "surfaces as a worker-failure (merge-conflict envelope, issue flipped to `ready-for-human`)" routing so authors know exactly what an abort costs. `post_merge` row carries `RED_AFK_MERGE_COMMIT` (full sha) plus `RED_AFK_MERGE_SHA` (short sha) so a Slack notifier can build the merge URL, the mutable slice `{issue, workspace, merge_commit}` extended by the `validation` default with `result.{validation_status, validation_summary}`, and the continue policy with the explicit "merge has already landed; a broken notifier or a flaky smoke test must never roll it back" rationale. Both rows call out the mechanism-between-hooks invariant ("The merge itself plus conflict resolution remain **mechanism** (ADR 0008) and sit between `pre_merge` and `post_merge` — never dispatched as a hook") so the boundary with `lib/merge.sh` is visible directly in the table. Extends the *Built-in defaults* table with the `validation` row describing the migration and explicitly noting that the pre-merge `feedback()` step remains as the mechanism-owned safety gate (only mechanism can refuse a merge per ADR 0008), so this default is an observability + notification surface, not a gate.
- **compatibility**: additive only. The legacy `hooks.sh`-based `pre-merge` / `post-merge` three-layer chain continues to run with no change to its semantics — the new `hook_dispatch pre_merge` / `post_merge` calls fire immediately after the legacy ones at the same lifecycle moment, so existing project-level `.red/hooks/pre-merge.sh` / `post-merge.sh` files keep working. The inline `feedback()` pre-merge call in `process_issue` is **not removed**: it remains the mechanism-owned safety gate per ADR 0008, and the post_merge `validation` default runs an additional CI/smoke pass against the merged tip so user hooks see a reconciled context. Authors who want pre-merge guards (e.g. reject diffs > 5k LOC) write a user `pre_merge` hook; authors who want post-merge notifications (e.g. Slack with the merge commit URL) write a user `post_merge` hook. Disabling `afk.hooks.defaults.validation` removes only the post-merge re-run; the pre-merge gate stays.

---

## afk lifecycle hooks — post_worker / on_worker_error + heartbeat/envelope post_worker defaults (added)

- **status**: added
- **upstream**: —
- **why**: Issue #212 (under PRD #207) — second AFK lifecycle slice. Wires `post_worker` (after the runner returned — success or clean failure) and `on_worker_error` (after a runner-crash exit, **not** on `result.status=fail`) into `process_issue`, and migrates the inline `heartbeat_stop` call plus the implicit "intermediate envelope update" into registered built-in `post_worker` defaults that run before any user hook.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: captures `run_inner`'s rc into a local; on a non-zero rc that is **not** quota exhaustion, dispatches `on_worker_error` with `{issue, workspace, error:{class:"runner-crash", rc}}` (`RED_AFK_ERROR_CLASS=runner-crash`) and flips the issue to `ready-for-human`. On the normal post-runner path, classifies `result.status` from the `<promise>DONE</promise>` sentinel (success / fail), exports `RED_AFK_RESULT_STATUS`, `RED_AFK_HEARTBEAT_PID`, `RED_AFK_ITER_LOG`, `RED_AFK_STATE_FILE`, and dispatches `post_worker` with `{issue, workspace, result:{status}}`. Both new hooks are `continue`-policy (already declared in `lib/hook-dispatcher.sh` by #208) so a broken notifier/pager cannot wedge the loop. The bare `heartbeat_stop` that used to sit between `run_inner` and the sentinel-detection block is gone — the `heartbeat` built-in default that now runs at the head of the `post_worker` chain owns that responsibility, and the parent-shell `HEARTBEAT_PID` is cleared after the dispatch so a later `cleanup()` trap is a no-op rather than killing the wrong pid.
  - `plugins/dev/skills/engineering/afk/scripts/lib/hook-config.sh`: extends `hook_config_register_defaults()` to register `heartbeat` and `envelope` `post_worker` defaults (heartbeat first, then envelope), gated by `HOOK_DEFAULTS_DISABLED[heartbeat|envelope]` set from `afk.hooks.defaults.<name>: false`. Same defaults-first ordering as #211 — user `post_worker` hooks always run after the migrated defaults.
  - `plugins/dev/skills/engineering/afk/defaults/heartbeat-post-worker.sh` (new, executable): drains stdin (pass-through, empty stdout), then — if `RED_AFK_HEARTBEAT_PID` is set and the pid is still alive — `kill`s it and `wait`s for the reap; appends the `iteration stopped` boundary marker to `RED_AFK_ITER_LOG` when present. Always exit 0.
  - `plugins/dev/skills/engineering/afk/defaults/envelope-post-worker.sh` (new, executable): reads ctx from stdin and writes `current.result_status` (= `ctx.result.status`, falling back to `RED_AFK_RESULT_STATUS`) onto `RED_AFK_STATE_FILE` via `jq` + atomic mv. Pure side-effect; empty stdout. No-op (still rc=0) when the state file is missing.
  - `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-post-worker-on-error.test.sh` (new): 57-assertion suite covering wiring (exactly one of each dispatch; on_worker_error precedes post_worker so a crash short-circuits the clean path; gated by `_runner_rc != 0` and `RUNNER_EXHAUSTED -ne 1`; post_worker classifies success on DONE and exports the documented env vars; the inline pre-sentinel `heartbeat_stop` is gone), dispatcher policies (`post_worker=continue`, `on_worker_error=continue`) and canonical-name membership, defaults file existence + executability, defaults-then-user ordering (heartbeat, envelope, then user hooks — total = 4) with individual `defaults.heartbeat: false` / `defaults.envelope: false` / both-disabled toggles, heartbeat default reaping a real spawned sub-shell and writing the boundary marker (empty-env path is a clean no-op), envelope default writing `current.result_status` (success / fail) to a real state file, preserving siblings, using `RED_AFK_RESULT_STATUS` as fallback when ctx is empty, and no-op'ing when the state file is missing, `continue` policy on a failing user hook (rc=0 round-trips, failure logged), and SKILL.md coverage (post_worker, on_worker_error, the new defaults' disable toggles, `RED_AFK_RESULT_STATUS` / `RED_AFK_ERROR_CLASS` contracts, and the post_worker / on_worker_error distinction).
  - `plugins/dev/skills/engineering/afk/SKILL.md`: extends the *Lifecycle Hooks* table with `post_worker` (env vars + `result:{status}` mutable slice + continue policy + "does not fire on runner crash or exhaustion") and `on_worker_error` (env vars + `error:{class, rc}` slice + the rationale that the two hooks are deliberately distinct so authors do not have to demultiplex on `result.status`) rows. Extends the *Built-in defaults* table with `heartbeat` and `envelope` rows describing the migration. Worked YAML example and disable-not-reorder rule are unchanged from #211.

---

## afk lifecycle hooks — pre_worktree / pre_worker + built-in cargo/gradle defaults (added)

- **status**: added
- **upstream**: —
- **why**: Issue #211 (under PRD #207) — first AFK lifecycle slice that introduces the **built-in default registration mechanism**. Wires `pre_worktree` (after claim, before `git worktree add`) and `pre_worker` (after worktree exists, before runner boots) into `process_issue`, and migrates the existing `cargo` and `gradle` detectors from the legacy `hooks.sh`-only `pre-spawn` chain into registered `pre_worktree` defaults that user hooks (and the runner) inherit env vars from.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: wires `pre_worktree` immediately before `git -C "$PROJECT_ROOT" fetch origin / worktree add` — mutable slice `{issue, target, env}`, `branch` read-only; abort policy restores `ready-for-agent`, tears down the iteration, and never creates the worktree. After the chain succeeds, applies the mutated `.target` (if changed) and exports every `.env.<KEY>=<VAL>` into the parent shell so subsequent hook commands and the runner inherit them (e.g. `CARGO_TARGET_DIR`). Wires `pre_worker` immediately after the post-commit-hook install / session-id mint / state-write block, before `run_inner` — mutable slice `{issue, workspace}`, `runner` read-only; abort policy stops the heartbeat, returns the claim to `ready-for-agent`, and preserves the worktree on disk for the next iteration.
  - `plugins/dev/skills/engineering/afk/scripts/lib/hook-config.sh`: extends `hook_config_register_defaults()` to register `cargo` and `gradle` `pre_worktree` defaults in fixed alphabetical order, gated by `HOOK_DEFAULTS_DISABLED[<name>]` set from the `afk.hooks.defaults.<name>: false` toggles. Defaults run **before** any user `pre_worktree` command at the same point (the loader already registered defaults-first; only the body of `hook_config_register_defaults` changed). Always anchors the `defaults/` path on the file's own `_HOOK_CONFIG_DIR` rather than `$RED_AFK_PLUGIN_DIR` — that env var may point at a co-installed copy of the skill that has not yet picked up new defaults shipped in a worktree.
  - `plugins/dev/skills/engineering/afk/defaults/cargo-pre-worktree.sh` (new, executable): pre_worktree default for Rust projects. Empty stdout (pass-through) when no `Cargo.toml` at `$PROJECT_ROOT`. Otherwise `mkdir -p` the slot dir and emit `{env: {CARGO_TARGET_DIR: <slot>}}` merged into the input ctx. Honors `RED_AFK_CARGO_TARGET_BASE` (default `/opt/cargo-target`) + `RED_AFK_SLOT` (default `0`). Always exit 0 — N/A is a pass-through, never an abort.
  - `plugins/dev/skills/engineering/afk/defaults/gradle-pre-worktree.sh` (new, executable): same shape for Gradle, but additionally requires the opt-in `RED_AFK_GRADLE_USER_HOME_BASE` env var. Without it the default is a silent no-op — AFK does not claim a path on the user's filesystem without consent.
  - `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-pre-worktree-pre-worker.test.sh`: 50 assertions covering (1) wiring placement (exactly one of each dispatch, pre_worktree before `worktree add`, pre_worker between `worktree add` and `run_inner`), (2) dispatcher policies (`pre_worktree=abort`, `pre_worker=abort`) and canonical-name membership, (3) defaults files exist + executable, (4) defaults-first ordering in the config-loader output (cargo, gradle, then user hooks in declaration order — total = 4 cmds), (5) `defaults.cargo: false` skip leaves gradle + user intact, `defaults.gradle: false` skip leaves cargo + user intact, both-disabled leaves only user, (6) cargo pass-through when no `Cargo.toml`, mutation when present (env + slot dir on disk + existing ctx preserved), (7) gradle pass-through when `build.gradle*` missing OR opt-in env unset, mutation when both present, (8) defaults-then-user chain end-to-end through the dispatcher (a user hook reads `.env.CARGO_TARGET_DIR` populated by the cargo default that ran before it), (9) exit-code policy for both hooks (abort propagates rc, failure logged with `rc=<n>`), (10) user-list declaration order preserved within `pre_worker`, and (11) SKILL.md documents both hooks, the cargo + gradle disable toggles, and the disable-not-reorder rule.
  - `plugins/dev/skills/engineering/afk/SKILL.md`: extends the *Lifecycle Hooks* table with `pre_worktree` and `pre_worker` rows (env vars, mutable slice, exit-code policy) and adds a new *Built-in defaults* sub-section with a per-default table (lifecycle point, effect, disable toggle) and an extended worked YAML example showing the cargo/gradle defaults running before a user `pre_worktree` hook that reads `$CARGO_TARGET_DIR`, plus the `defaults.gradle: false` opt-out.
- **compatibility**: additive only. No change to existing `pre_session` / `pre_pick` / `post_pick` / `on_idle` / `post_session` semantics. The `hook-dispatcher` `HOOK_EXIT_POLICY[pre_worktree]=abort` / `[pre_worker]=abort` already shipped with #208 govern the new wiring — no policy-table edit needed. The legacy `hooks.sh`-based `pre-spawn` detector chain (still loaded by `log_applied_detectors_boot_line`) is left untouched: `detectors/cargo.sh` and `detectors/gradle.sh` continue to apply at worker boot exactly as before. The new `pre_worktree` defaults run per-issue on top, exporting the same vars into the parent shell so the worktree-bound runner inherits them even when the legacy chain is bypassed (e.g. when a custom `pre_session` clears the env).

---

## afk lifecycle hooks — pre_pick / post_pick + only-mine.sh example (added)

- **status**: added
- **upstream**: —
- **why**: Issue #210 (under PRD #207) — first AFK lifecycle slice that exercises the **JSON-stdout context mutation** path of the interceptor contract. `pre_pick` lets users mutate the tracker-listing query params; `post_pick` lets users filter/reorder the returned queue before claiming. Ships `examples/only-mine.sh` to demonstrate the end-to-end pattern.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: refactored `select_issues()` to read `PICK_LABEL` / `PICK_STATE` / `PICK_LIMIT` (defaults preserve historical hardcoded values) and to include `author` in the `--json` fields so author-based filters can work. Wired `pre_pick` immediately before `select_issues` — mutable slice `{label, state, limit}`; `abort` policy means a non-zero hook skips listing this iteration and falls through to the empty-queue / `on_idle` path. Wired `post_pick` immediately after `select_issues`, before the per-issue main loop — mutable slice is `.issues` inside a `{issues:[…]}` wrapper (extra keys ignored). `continue` policy means a broken filter falls back to the un-mutated list rather than silently dropping work.
  - `plugins/dev/skills/engineering/afk/examples/only-mine.sh` (new, executable): example `post_pick` hook that reads `$RED_AFK_GITHUB_LOGIN` and filters `.issues[]` by `author.login`. When the env var is unset the hook is a no-op (empty stdout → context unchanged) — so declaring it without configuring the login does not wipe the queue.
  - `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-pre-post-pick.test.sh`: 39 assertions covering wiring placement (exactly one of each, pre before `select_issues`, post after but before the main loop), dispatcher policies, mutation happy paths for both hooks, empty-stdout pass-through, ignored extra keys, exit-code policy (pre_pick abort propagates rc; post_pick continue logs and returns rc=0 with the un-mutated list), declaration-order preservation, chained mutation (second hook sees first hook's output), SKILL.md doc surface, and `only-mine.sh` end-to-end through the dispatcher.
  - `plugins/dev/skills/engineering/afk/SKILL.md`: extends the *Lifecycle Hooks* table with `pre_pick` and `post_pick` rows (env vars, mutable slice, exit-code policy) and adds the `only-mine.sh` line to the worked YAML example.
- **compatibility**: additive only. No change to existing `pre_session` / `post_session` / `on_idle` semantics. The `hook-dispatcher` `HOOK_EXIT_POLICY[pre_pick]=abort` / `[post_pick]=continue` already shipped with #208 govern the new wiring — no policy-table edit needed. `select_issues` defaults preserve historical behaviour when the new `PICK_*` globals are unset.

---

## afk lifecycle hooks — on_idle (added)

- **status**: added
- **upstream**: —
- **why**: Issue #209 (under PRD #207) — second tracer slice for the AFK lifecycle hook system. Wires `on_idle` as the "between drains" maintenance point, distinct from `post_session`'s session-termination role. PRD demo case: `afk.hooks.on_idle: ["cargo clean -p reddb-storage"]` fires exactly when the storage cache is no longer load-bearing for the next worker.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: dispatch `on_idle` inside the `TOTAL -eq 0` branch (queue drained at top of loop iteration), before the `NO MORE TASKS` exit. Context passes `runner`, `worker_id`, and `stats.{done,blocked,total}` (read-only in this slice — no mutable slice). Non-zero is logged and the session still exits cleanly per the dispatcher's `continue` policy. The post-loop session-exit path is untouched: only `post_session` fires there.
  - `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-on-idle.test.sh`: covers the wiring (dispatch sits inside the empty-queue branch, before exit; exactly one site; precedes the per-issue loop), the dispatcher policy (`continue`), canonical-name set membership, the PRD's `cargo clean` example end-to-end (non-zero rc=101 logged, dispatch returns 0, ctx unchanged, follow-up command still runs), and the SKILL.md doc surface.
  - `plugins/dev/skills/engineering/afk/SKILL.md`: extends the *Lifecycle Hooks* table with an `on_idle` row (when it fires, env vars, "none" mutable slice, exit-code policy) and adds the `cargo clean -p reddb-storage` line to the worked YAML example.
- **compatibility**: additive only. No change to `pre_session`/`post_session` semantics, no built-in defaults registered. The existing `hook-dispatcher` `HOOK_EXIT_POLICY[on_idle]=continue` from #208 is what governs the new wiring — no policy table edit needed.

---

## afk lifecycle hooks — dispatcher + config loader + pre_session/post_session (added)

- **status**: added
- **upstream**: —
- **why**: Issue #208 (under PRD #207) — first tracer bullet for the AFK lifecycle hook system. Introduces the dispatcher contract (env vars + JSON-on-stdin + JSON-on-stdout + per-hook exit-code policy), the `afk.hooks.<name>` config block (with bare-string shorthand and hard-fail on unknown names), and the simplest pair of lifecycle points (`pre_session`, `post_session`) wired through `afk.sh`.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/lib/hook-dispatcher.sh`: new module owning `hook_dispatch <name> <ctx_json>` and `hook_register <name> <cmd>…`. Canonical lifecycle name set, `HOOK_EXIT_POLICY` table per PRD §"Per-hook exit-code policy", JSON-object stdout merge via `jq -e`, non-JSON stdout treated as parse failure (abort under `pre_*`, log-and-continue under `post_*` / `on_*` / `on_idle`).
  - `plugins/dev/skills/engineering/afk/scripts/lib/hook-config.sh`: minimal YAML reader for the `afk.hooks` subtree (no `yq` dependency, consistent with existing `config.sh`). Accepts bare-string shorthand and block lists, expands `defaults.<name>: false` into `HOOK_DEFAULTS_DISABLED`, and emits rc=3 on unknown hook names. Defaults register before user-declared hooks; declaration order preserved within each group.
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: sources the new modules and wires `pre_session` immediately after `bootstrap` (non-zero aborts the session with a visible log line) and `post_session` immediately before the final `<promise>NO MORE TASKS</promise>` (non-zero logged and skipped per policy).
  - `plugins/dev/skills/engineering/afk/scripts/tests/hook-dispatcher.test.sh`: covers env-var contract, stdin JSON shape, stdout merge happy path, chained mutations, parse-failure handling, exit-code policy for `pre_session` (abort) and `post_session` (continue), unknown lifecycle point, and the canonical-name set.
  - `plugins/dev/skills/engineering/afk/scripts/tests/hook-config.test.sh`: covers bare-string shorthand, block lists, unknown hook name hard-fail (both bare and list form), defaults toggle, mixed shapes, unrelated keys, and order preservation.
  - `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-pre-post-session.test.sh`: end-to-end wiring check — `afk.sh` sources the new modules and dispatches `pre_session`/`post_session`; YAML-driven config drives the registered list; env vars thread through to the hook bash subprocess.
  - `plugins/dev/skills/engineering/afk/SKILL.md`: new *Lifecycle Hooks* section enumerating the interceptor contract, ordering rules, and the two hooks shipped here (env vars, mutable slice, exit-code policy) with a worked YAML example.
- **compatibility**: additive only. The existing `hooks.sh` detector orchestrator and `config.sh` flat-scalar loader are untouched; both keep working and their tests still pass. No built-in defaults are migrated into the new dispatcher in this slice — that's the work of follow-up issues under PRD #207.

---

## README cross-runner task engine docs (added)

- **status**: added
- **upstream**: —
- **why**: Issue #203 — once `/afk` capability dispatch shipped (#202), the public docs still framed `/afk` as Claude-first with Codex as a fallback runner identity. The PRD #196 product story is the opposite: `/afk` plus the runner-neutral task contract at `.red/contracts/afk-task.md` is the surface, Claude Code-native sub-agents are an acceleration path, and Codex gets first-class workflow parity via `codex-phased`. Users opening the README need to see the compatibility matrix, the runner-agnostic user flow, the JS workflow decision from #197, and the deliberate non-promise about native Codex sub-agents (pending #204) — without re-reading the AFK SKILL.md to assemble that picture.
- **what changed**:
  - `README.md`: new *Cross-runner task engine* subsection inside `## ⚡ /afk` (after *Invocation modes*, before *Live monitor*). Documents the runner-neutral task contract, the five run modes (`claude-native` / `claude-basic` / `codex-phased` / `codex-basic` / `hermes-fallback`) as a table with required artefacts and inner-agent behaviour, the safe-degradation rule, the observable dispatch surface (log line, `current.run_mode`, `RED_AFK_RUN_MODE_RESOLVED`), the `RED_AFK_RUN_MODE` operator overrides, the runner-agnostic user flow diagram, the deliberate non-promise about native Codex sub-agents (pending #204), and the JS workflow decision (out of scope per #197 §3 — algorithmic logic stays in MCP/hooks, phase contracts stay in markdown). Every new public claim links to its evidence — the dispatch implementation (`scripts/lib/capabilities.sh`), the hermetic test (`scripts/tests/capabilities.test.sh`), the SKILL.md *Capability Dispatch* section, the runner-hermes doc, the Claude/Codex surface research docs, and the task contract.
- **compatibility**: docs-only. Adds one subsection to the `/afk` section of the README and changes no other surface. No new orchestrator code, no schema change, no behaviour change for any run. Preserves existing positioning around issue-native async execution, RTK, fleet mode, and the optional Memory plugin — the new subsection narrates the dispatch already wired in #202 rather than introducing any new capability.

---

## afk capability dispatch — runner-mode selection (added)

- **status**: added
- **upstream**: —
- **why**: Issue #202 — wire `/afk` runner selection to the cross-runner AFK task contract (#205) and the per-phase contracts (#199 / #200 / #201) plus the Claude (#197) and Codex (#204) surface research. The prior runner-detection cascade only resolved a runner *identity* (`claude` / `codex`); it never reported what that runner could actually do, so the orchestrator could not pick a path between native sub-agents, inline phases, and the runner-neutral fallback. This slice adds the capability probe + run-mode dispatcher so the optimised paths are taken when their production artefacts are present, and the existing sentinel-driven behaviour stays in force when they're not.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/lib/capabilities.sh`: new library. `capabilities_detect <runner>` emits `KEY=value` lines for a fixed axis set (`native_agents`, `structured_output`, `resume_session`, `worktree_support`, `hooks_events`, `permission_modes`, `phased_mode`). Probes are cheap — what the runner's `runner-*.md` already documents plus filesystem checks for `plugins/dev/agents/{issue-analyzer,task-executor,quality-gate}.md` (Claude native path) and `phases/codex/{analyze,verify,finalize}.md` (Codex phased path). `capabilities_select_mode <runner> [kv...]` echoes one of `claude-native` / `claude-basic` / `codex-phased` / `codex-basic` / `hermes-fallback`. Native and phased modes degrade to their basic counterparts when artefacts are missing; an unknown runner identity always routes to `hermes-fallback`. Operator overrides via `RED_AFK_RUN_MODE` (`auto` / `basic` / `native` / `phased` / `fallback`) with native/phased honoured only when the env can satisfy them.
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: `run_inner` now probes the runner, selects the mode, logs `dispatch: runner=<r> mode=<m> <kv...>` to `afk.log`, persists `current.run_mode` in `afk.state.json`, exports `RED_AFK_RUN_MODE_RESOLVED` for child processes, and dispatches per-mode. Native and phased modes currently call through to `run_claude` / `run_codex` because the production sub-agent files and Codex phase prompts are scoped to #199/#200/#201 (not this issue). Hermes-fallback funnels to whichever existing process backend the runner parameter names, preserving the sentinel contract.
  - `plugins/dev/skills/engineering/afk/scripts/lib/state.sh`: `_STATE_JQ_FILTER` extended with one new field — `current.run_mode` — so the state-reader functions, `/afk monitor`, and forensic readers can surface the mode alongside `current.stage` and `current.runner`. Defaults to empty string for old state files.
  - `plugins/dev/skills/engineering/afk/scripts/tests/capabilities.test.sh`: new hermetic unit test (22 cases) covering the probe table for both runners, native/phased promotion, partial-artefact degradation back to basic, unknown-runner → fallback, the four `RED_AFK_RUN_MODE` overrides, and the dispatch-log line shape. Uses `CAPABILITIES_AGENTS_DIR` / `CAPABILITIES_CODEX_PHASE_DIR` / `CAPABILITIES_HAS_WORKTREE` overrides so the probe never reads the real plugin tree or spawns a runner binary.
  - `plugins/dev/skills/engineering/afk/SKILL.md`: new *Capability Dispatch (issue #202)* section after *Runner Fallback*. Documents the run-mode table, the degradation rule, the log/state/exported-env surface, the operator overrides, and the lifecycle invariant — mode is metadata about *how* the work happened, never authority over *what* counts as completion.
  - `plugins/dev/skills/engineering/afk/runner-hermes.md`: new runner doc for the `hermes-fallback` mode — what it does *not* provide (structured output, native delegation, resume, hooks, permission modes), the spawn contract (no third process backend today; the runner parameter still names the actual binary), the worktree-as-cwd contract, and the same sentinel-based lifecycle signalling Claude and Codex use.
- **compatibility**: the dispatch is **additive** — the cross-runner contract at `.red/contracts/afk-task.md` already states that "until #199–#202 land, the orchestrator does not require any envelope" and that `<promise>DONE</promise>` / `<promise>BLOCKED</promise>` sentinels remain the lifecycle signal. This slice satisfies that compatibility note by construction: when the production sub-agents and phase prompts are absent (today on every installation), the dispatcher degrades to the same `run_claude` / `run_codex` paths the orchestrator already shipped, so existing `/afk` runs behave identically. The new `current.run_mode` state field is the only observable change, and old state files default it to empty without erroring. Blocked / escalation results continue to flow through the existing envelope poster to `ready-for-human`; successful results continue to pass through the existing merge / cleanup safeguards. `/afk monitor` and the state-reader functions surface the mode in their live-vs-stale reporting; the field is read through the same `_STATE_JQ_FILTER` path as every other `current.*` field, so the monitor needs no parallel change.

---

## afk inner-agent prompt — task-adherence checklist (added)

- **status**: added
- **upstream**: —
- **why**: Issue #206 — task adherence must be a cross-runner contract requirement, not a Claude-only prompt tweak. The #205/#199/#200/#201 contracts already define the runner-neutral adherence rules (executor `out_of_scope_rejections` / `non_goals_preserved`, quality-gate `stub_findings` / `scope_drift_findings` / `acceptance_verification`, base-envelope hollow-success), but those contracts are documentation-only until production wiring lands. This slice promotes the adherence rules into the prompt layer that every runner shares today, so adherence binds Claude Code, Codex CLI, and the fallback runner without waiting for the per-phase sub-agents in PRD #196.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/AGENT-PROMPT.md`: new binding Task Adherence section after What Done Means. Seven-step checklist that writes per-step blocks into `<agent-notes>` (`## Scope:`, `## Non-goals:`, `## Files:`, `## Commands:`, `## Acceptance Summary`, `## Out-of-scope edits:` / `## Out-of-scope rejections:`, `## Verification:`, `## Hollow-completion check:`, `## Guidance applied:`). The hollow-completion clause encodes the quality-gate stub-detection taxonomy as a hard refusal of `<promise>DONE</promise>` — the inner agent self-gates on integrity-of-evidence failures (skipped tests, placeholder patterns, zero-test-match, docs-only-for-code-task, test edits that mask failures), not just on failing test runners. The Acceptance Summary block format pins the row shape (status enum + criterion + evidence string) so the orchestrator's existing `envelope_extract_notes` poster surfaces per-criterion status in the issue comment.
  - `.red/contracts/afk-task.md`: new Task Adherence section in the cross-runner envelope contract. Names adherence as a three-layer rule (prompt, phase-envelope, base-envelope), points each layer at its existing enforcer, documents the equivalence between the `## Acceptance Summary` markdown block and the `acceptance_criteria_results` JSON array, and records per-runner status — prompt layer is active today on all three runners because `runner-claude.md` and `runner-codex.md` both spawn with the same `AGENT-PROMPT.md` body.
- **compatibility**: prompt-only and documentation-only. No orchestrator code changed — the existing `envelope_extract_notes` path in `scripts/lib/envelope.sh` already publishes `<agent-notes>` verbatim into the issue comment, so the per-criterion audit trail flows through the existing envelope without any new poster code. The `<promise>DONE</promise>` / `<promise>BLOCKED</promise>` sentinels remain the lifecycle signal. The Task Adherence checklist is "reused where practical" across Claude, Codex, and Hermes by construction (single shared prompt body), not by duplicating prompt text per runner.

---

## quality-gate contract — verify_task phase schema (added)

- **status**: added
- **upstream**: —
- **why**: Third runner-neutral phase contract built on top of the #205 envelope and the #200 executor (PRD #196 / issue #201). Defines the `verify_task` phase that runs between executor completion and `finalize`'s commit/merge: discovers and runs repo-local quality commands (preferring RTK / hook-backed wrappers when safe), grades each acceptance criterion against the captured evidence, detects skipped tests / hollow tests / zero-test matches / placeholder implementations, flags scope drift, and emits a structured `approved` / `blocked` / `stub_detected` outcome. Lets Claude Code sub-agents, Codex CLI inline phases, and Hermes fallback emit the same gate output without changing `/afk` runtime behavior yet.
- **what changed**:
  - `.red/contracts/quality-gate.md`: phase contract document — inputs limited to the existing issue/handoff artefacts plus optional analyzer/executor envelopes and the worktree diff, output specialization of the base envelope with an additional `quality_gate` object (outcome, checks_run, discovered_commands, stub_findings, scope_drift_findings, acceptance_verification, fixes_applied, fixes_rejected, rtk_used), verify-phase invariants, outcome priority rules (stub_detected > blocked > approved), stub-detection taxonomy, scope-drift / unproven-acceptance / failed-acceptance failure modes, allowed-vs-rejected fix rubric, RTK and hook-backed wrapper preference, per-runner emission notes, and Claude Code packaging notes referencing `plugins/dev/agents/` and the #198 agent-metadata validator.
  - `.red/contracts/quality-gate.schema.json`: JSON Schema (draft 2020-12) pinning `phase` to `verify_task`, allowing acceptance results in {pass, fail, unverified}, requiring the closed `quality_gate` object with non-empty enums for outcome / stub-kind / verification-source, and encoding the outcome-vs-envelope invariants (approved => status=completed, all-pass acceptance, empty failures / stubs / scope-drift; stub_detected => status in {blocked, escalation_needed}, stub_findings non-empty, next_human_action set; blocked => status in {blocked, escalation_needed}).
  - `.red/contracts/fixtures/quality-gate/`: 9 fixtures — 4 valid (`approved-normal`, `blocked-test-failure`, `stub-detected-skipped-test`, `stub-detected-scope-drift`) and 5 invalid (`missing-quality-gate`, `malformed-json`, `approved-with-failure`, `approved-with-unverified`, `checks-mismatch`) covering every outcome and the four documented failure modes.
  - `scripts/validate-quality-gate-contract.sh`: jq-only structural validator mirroring `validate-task-executor-contract.sh`; enforces required keys, enums (status, runner, confidence, result, outcome, stub-kind, verified), verify-phase invariants (verification_commands ↔ verification_results ↔ quality_gate.checks_run same length / same commands / same exit codes), the outcome-vs-envelope invariants, the base hollow-success rule, and the per-object shapes of `checks_run`, `discovered_commands`, `stub_findings`, `scope_drift_findings`, `acceptance_verification`, `fixes_applied`, and `fixes_rejected`.
  - `scripts/test-validate-quality-gate-contract.sh`: fixture-based test wired into `.github/workflows/red-release.yml` alongside the existing agent-metadata, afk-task, issue-analyzer, and task-executor fixture tests.
- **compatibility**: documentation-only. `/afk` does not yet invoke the quality-gate or consume its envelope; the orchestrator continues to drive on the `<promise>DONE</promise>` / `<promise>BLOCKED</promise>` sentinels. Production wiring (and the live merge gate that reacts to `approved` / `blocked` / `stub_detected`) is deferred to later PRD #196 slices. Per #204 §4, public copy treats Codex emission as an inlined phase, not as a "Codex sub-agent". No commit/merge behavior is moved into the gate; the gate's allowed fixes are restricted to mechanical, in-scope edits and are recorded in `quality_gate.fixes_applied`.

---

## task-executor contract — execute_task phase schema (added)

- **status**: added
- **upstream**: —
- **why**: Second runner-neutral phase contract built on top of the #205 envelope and the #199 analyzer (PRD #196 / issue #200). Lets Claude Code sub-agents, Codex CLI inline phases, and Hermes fallback emit the same structured `execute_task` output without changing `/afk` runtime behavior yet, and pins the executor's role to scoped implementation only (no commit, no quality gates).
- **what changed**:
  - `.red/contracts/task-executor.md`: phase contract document — inputs limited to the existing handoff/issue artefacts plus an optional analyzer envelope, output specialization of the base envelope with an additional `execution` object (implementation_summary, changes_by_criterion, out_of_scope_rejections, non_goals_preserved, commit_hint, escalation_triggers, follow_ups), execute-phase invariants, scope rules (no commit/merge, no quality gates, no out-of-scope writes, no new queues), escalate-vs-block rubric, per-runner emission notes, and Claude Code packaging notes referencing `plugins/dev/agents/` and the #198 agent-metadata validator.
  - `.red/contracts/task-executor.schema.json`: JSON Schema (draft 2020-12) pinning `phase` to `execute_task`, forcing the unverified-only acceptance-results invariant, requiring empty verification/quality-gate arrays, requiring the closed `execution` object, and adding the completed-status invariants (`changed_files` non-empty, every `changes_by_criterion[*].status` is `implemented`).
  - `.red/contracts/fixtures/task-executor/`: 5 fixtures — 2 valid (`normal-implementation` covering an unambiguous completed executor envelope, `blocked-out-of-scope` covering an escalation triggered by an out-of-scope human-guidance ask) and 3 invalid (`missing-execution`, `malformed-json`, `completed-without-changes`).
  - `scripts/validate-task-executor-contract.sh`: jq-only structural validator mirroring `validate-issue-analyzer-contract.sh`; enforces required keys, enums, execute-phase invariants (no quality gates, all results unverified, completed requires non-empty changed_files and all changes implemented), the execution object's required fields and shapes, and the subset rule that `changes_by_criterion[*].files_touched` ⊆ `changed_files`.
  - `scripts/test-validate-task-executor-contract.sh`: fixture-based test wired into `.github/workflows/red-release.yml` alongside the existing afk-task, issue-analyzer, and agent-metadata fixture tests.
- **compatibility**: documentation-only. `/afk` does not yet invoke the executor or consume its envelope; the orchestrator continues to drive on the `<promise>DONE</promise>` / `<promise>BLOCKED</promise>` sentinels. Production wiring is deferred to later PRD #196 slices. Per #204 §4, public copy treats Codex emission as an inlined phase, not as a "Codex sub-agent". No commit/merge behavior is moved into the executor.

---

## issue-analyzer contract — analyze_issue phase schema (added)

- **status**: added
- **upstream**: —
- **why**: First runner-neutral phase contract built on top of the #205 envelope (PRD #196 / issue #199). Lets Claude Code sub-agents, Codex CLI inline phases, and Hermes fallback emit the same structured `analyze_issue` output without changing `/afk` runtime behavior yet.
- **what changed**:
  - `.red/contracts/issue-analyzer.md`: phase contract document — inputs limited to the existing handoff/issue artefacts, output specialization of the base envelope with an additional `analysis` object (task_type, affected_area, recommended_skills, risk_level, scope_boundaries, acceptance_criteria_map, verification_expectations, open_questions, ambiguity_score), analyze-phase invariants, per-runner emission notes, and Claude Code packaging notes referencing `plugins/dev/agents/` and the #198 agent-metadata validator.
  - `.red/contracts/issue-analyzer.schema.json`: JSON Schema (draft 2020-12) pinning `phase` to `analyze_issue`, forcing the unverified-only acceptance-results invariant, requiring the closed `analysis` object, and adding cross-field invariants for `task_type=unknown` and `ambiguity_score=high`.
  - `.red/contracts/fixtures/issue-analyzer/`: 5 fixtures — 2 valid (`normal-feature` covering an unambiguous issue, `escalation-ambiguous` covering an ambiguous escalation) and 3 invalid (`missing-analysis`, `unverified-but-completed`, `ambiguity-without-questions`).
  - `scripts/validate-issue-analyzer-contract.sh`: jq-only structural validator mirroring `validate-afk-task-contract.sh`; enforces required keys, enums, analyze-phase invariants (no executed work, all results unverified), the analysis object's required fields and shapes, and the two cross-field invariants.
  - `scripts/test-validate-issue-analyzer-contract.sh`: fixture-based test wired into `.github/workflows/red-release.yml` alongside the existing afk-task and agent-metadata fixture tests.
- **compatibility**: documentation-only. `/afk` does not yet invoke the analyzer or consume its envelope; the orchestrator continues to drive on the `<promise>DONE</promise>` / `<promise>BLOCKED</promise>` sentinels. Production wiring is deferred to later PRD #196 slices. Per #204 §4, public copy treats Codex emission as an inlined phase, not as a "Codex sub-agent".

---

## afk-task contract — runner-neutral envelope schema (added)

- **status**: added
- **upstream**: —
- **why**: Foundational spine for PRD #196: Claude Code sub-agents, Codex CLI inline phases, and Hermes fallback must speak the same lifecycle language. Issue #205.
- **what changed**:
  - `.red/contracts/afk-task.md`: runner-neutral phase contract (`analyze_issue → execute_task → verify_task → fix_or_escalate → finalize`), required-field table, per-runner consumption notes, and the hollow-success rule.
  - `.red/contracts/afk-task.schema.json`: JSON Schema (draft 2020-12) with conditional requirements for `blocked` / `escalation_needed`.
  - `.red/contracts/fixtures/afk-task/`: 6 fixtures — 3 valid (`completed-execute`, `blocked-execute`, `escalation-verify`) and 3 invalid (`malformed-json`, `missing-fields`, `hollow-success`).
  - `scripts/validate-afk-task-contract.sh`: jq-only structural validator (no node/python deps); enforces required keys, enums, conditional fields, and the hollow-success detector.
  - `scripts/test-validate-afk-task-contract.sh`: fixture-based test wired into `.github/workflows/red-release.yml` alongside the existing agent-metadata fixture test.
- **compatibility**: documentation-only. `/afk` continues to use the `<promise>DONE</promise>` / `<promise>BLOCKED</promise>` sentinels. Production wiring is deferred to #199–#202. No runner is required to emit the envelope until then; Codex stays "phased task execution" in public copy (no native sub-agents promised), per #204 §4.

---

## memory — AFK lifecycle hook (`memory afk-finalize`) (added)

- **status**: added
- **upstream**: —
- **why**: Issue #187 (parent PRD #174). AFK workers had no end-of-worktree memory sequence — typed L2 candidates from a session could be lost if neither the L2 overflow backstop nor a `Stop`/`PreCompact` hook fired before the worktree was torn down, and the raw transcript blob vanished with the rest of L2 even when re-extraction with a better prompt would have been valuable.
- **what changed**: New `plugins/memory/src/afk-lifecycle.ts` exporting `runAfkLifecycle(store, rootDir, { worktreeId, sessionId? })` that runs three steps: (1) `runPromote` with `triggeredBy: "hook"` for the session id — every typed candidate gets dedup-checked regardless of overflow thresholds; (2) read the L2 raw transcript blob and upsert it into L3 as a `transcript` node (new `NodeType` variant added to `schema.ts`) with `scope: "worktree"`, `scope_id: worktreeId`, plus `worktree_id` / `session_id` properties and provenance evidence, using a stable label (`transcript:worktree:<wid>:session:<sid>`) so a repeat call is a content-hash dedup hit rather than a new row; (3) drop every L2 node for the session via the existing `recordEvicted` overlay (slice #182 semantics) so the rows stop surfacing through `listNodes` immediately. New CLI verb `memory afk-finalize --worktree <id> [--session <id>] [--json] [--root <dir>]` wired into the dispatcher; falls back to `RED_AFK_WORKER_ID` / `RED_AFK_ITER_DIR` env vars so the AFK post-iteration lifecycle hook can invoke it with no extra plumbing. Uses the existing transcript reader path (`getRawTranscript`) when the session file is still present, falling back to a session-id-keyed L2 scan when the runner already dropped `.red/memory/sessions/current` before finalize fires. Idempotency: step 1 is a no-op when no L2 events remain; step 2 dedups via `upsertNode`'s `(label, node_type, title, content, scope, scope_id)` content hash; step 3 finds nothing on a second call. Tests in `plugins/memory/tests/afk-lifecycle.test.ts` cover the happy path (promote+archive+drop), no-op re-invocation (single transcript node survives across two calls), and the detached-session path (sessionId override after the file has been torn down). Refs #187.

## memory — hot-read latency bench vs AMS (`memory bench latency`) (added)

- **status**: added
- **upstream**: —
- **why**: Issue #186 (parent PRD #174). The recall-quality bench (#185) covered ranking, not the second half of the "better than AMS" positioning: hot-read latency. RedDB's L1/L2 cache should dominate over the wire-protocol overhead of AMS-on-Redis at p50; p99 is the real fight and the most informative number. Without an executable, reproducible measurement, the claim has no defensible numbers.
- **what changed**: New `plugins/memory/src/bench-latency.ts` measures three op classes — `working-get` (L2 read by session id), `session-recall` (top-`k` scan over a session), `long-term-recall` (`FANOUT=8` L3 ids per op) — against two in-process strategies: **ours** = direct Map lookup mirroring an L1/L2 cached read; **ams_reference** = JSON-serialised payload + `JSON.parse` per response + client-side fan-out across keys, modelling what any Redis-backed `agent-memory-server` pays on every hot read. Neither path sleeps; both do only real CPU work. Workload is seeded `mulberry32(0xa11ce)` with 5000 iters + 500 warmup over 32 sessions × 24 events + 512 long-term nodes × 256-char payloads (all overridable via `--iterations` / `--warmup` / `--seed` / `--ops`, plus an optional `bench/latency/workload.json`). Reports p50/p95/p99/p99.9/mean per strategy plus `delta` and `speedup` rows under schema `memory.bench.latency.v1`. New CLI verb `memory bench latency [--workload <dir>] [--iterations N] [--warmup N] [--seed N] [--ops ...] [--out <file>] [--report <file>] [--json]` wired into the existing `runBench` dispatcher alongside `bench recall`. New `plugins/memory/bench/latency/README.md` documents the workload, op semantics, and reproducibility tolerance. Initial dated report under `plugins/memory/bench/results/2026-05-26-latency.md` linked from `plugins/memory/README.md`. Refs #186.

---

## memory — MCP tier-aware verbs (session/working/promote) (added)

- **status**: added
- **upstream**: —
- **why**: Issue #188 (parent PRD #174). The CLI stays tier-agnostic for humans (`memory store` / `memory recall` route through the layer router), but agents that need precision had no way to drive the L2 working-memory layer (#178) or the PromotionEngine (#183) from MCP. This adds five tier-aware tools so agents can mint a session, append typed L2 events, read the stream back, and promote it into L3 deliberately — complementing the harness-hook path from slice #176.
- **what changed**: New tools registered on the memory MCP server (`plugins/memory/src/mcp-server.ts`): `memory_session_start` (mints + writes `.red/memory/sessions/current`, optional caller-supplied `id`), `memory_session_end` (drops the file), `memory_working_get` (lists typed L2 events for the current session, optional `type` filter), `memory_working_set` (appends a typed event; triggers the L2 overflow promotion backstop when the threshold is crossed), and `memory_promote` (runs `runPromote` against L3, returning `promoted / reinforced / skipped` + rids + decisions). Working-memory and promote verbs require an active session; without one they throw a single uniform message — `"no active memory session — call memory_session_start first (or rely on the SessionStart hook to mint one)"` — so the agent can self-correct without human-in-the-loop. The existing read-only MCP surface is unchanged. README "MCP server" section gained a "Tier-aware verbs (agents)" subsection listing the five tools and the no-session contract. New end-to-end MCP test in `tests/mcp-server.test.ts` ("tier-aware verbs drive session / working-memory / promotion") exercises the full lifecycle: no-session error → `session_start` → `working_set` (sequence=1) → `working_get` round-trip → `promote` (promoted=1) → `session_end` → no-session error again → read-only `stats` still works. Full memory suite green; `pnpm typecheck` and `pnpm build` clean. Refs #188.

---

## memory — recall-quality bench vs AMS (`memory bench recall`) (added)

- **status**: added
- **upstream**: —
- **why**: Issue #185 (parent PRD #174). The "better than AMS for operational recall" claim needed an executable, reproducible measurement — not a marketing comparison. AMS leans on pure-vector recall (ADR 0005 documents why we do not aim for wire-compat); the bench tests whether our typed-graph + RRF path actually beats vector-only ranking on the operational query shapes that motivated the divergence (decisions / fixes / gotchas / reasoning chains).
- **what changed**: New labeled corpus under `plugins/memory/bench/recall/` (30 transcript chunks across `decision` / `fix` / `gotcha` / `reasoning` / `chat` shapes, plus 22 queries with `relevant_ids`). New `plugins/memory/src/bench-recall.ts` implements two ranking strategies against the in-memory corpus: **ours** = Reciprocal Rank Fusion over a keyword channel (token overlap), a vector channel (deterministic char-bigram cosine), and a graph channel (intent-type match + one-hop tag overlap inferred from the keyword-relevant subset) — mirroring the production `hybrid-recall` composer; **ams_reference** = pure vector cosine ranking only, the AMS recall path. Reports `precision@k` / `recall@k` at `k ∈ {1, 5, 10}` per-query and aggregated, with a `delta` row. New CLI verb `memory bench recall [--corpus <dir>] [--k 1,5,10] [--out <file>] [--report <file>] [--json]` wired through `runBench`. Initial dated report under `plugins/memory/bench/results/2026-05-26-recall.md` linked from `plugins/memory/README.md`. The bench is fully in-process, dependency-free, and byte-deterministic — same corpus + queries on the same git ref yields identical JSON (asserted as a test with zero tolerance). Tests (`tests/bench-recall.test.ts`, 9 assertions): corpus/query loader shape; `precision@k` / `recall@k` arithmetic; the hybrid finds doc-011 in the top-3 for q-008 (the postgres-deadlock fix query); AMS reference is order-stable; aggregate shape matches `memory.bench.recall.v1`; `JSON.stringify(a) === JSON.stringify(b)` across two runs; `delta.precision_at_k["5"] > 0` and `delta.recall_at_k["5"] > 0` — the hypothesis that hybrid beats vector-only on operational queries is enforced as a regression test, not a nice-to-have. Markdown report formatter covered. Full memory suite: 768 passed / 1 skipped. `pnpm typecheck` clean. `pnpm build` clean. Refs #185.

---

## memory — AMS importer (`memory import ams`) + migrating-from-ams porting guide (added)

- **status**: added
- **upstream**: —
- **why**: Issue #184 (parent PRD #174). ADR 0005 committed to **no wire compatibility** with Redis `agent-memory-server` (AMS) — AMS users migrate via a one-shot offline importer + porting guide, not a live shadow read. Without the importer + docs, the "better than AMS for the local-per-repo case" positioning has no defensible migration path.
- **what changed**: New `plugins/memory/src/import-ams.ts` reads an AMS JSON dump (`{ working_memory: [...], long_term_memory: [...] }`) and lands it in the local graph. `working_memory[].memories` map to L2 typed events partitioned by `session_id` (heuristic event-type inference from `memory_type` + `Decision:`/`Fix:`/`Gotcha:`/`Why:`/`Problem:`/`Solution:`/`Validation:`/`Goal:` text prefixes — falls back to `note_candidate`). `working_memory[].messages` map to a single L2 raw transcript blob per session. `long_term_memory[]` entries run through a candidate-shaped check that **first** asks the `ConflictDetector` (#179) — if a polarity flip / divergent-value / cross-session same-text contradiction is detected, the candidate is force-promoted so `MemoryStore.upsertNode`'s built-in detector writes `CONTRADICTS` edges instead of letting the dedup gate silently collapse the disagreement. Otherwise the PromotionEngine (#183) dedup gate runs over live L3 + the importer's in-batch shadow; near-dups bump reinforcement via the KV overlay. `user_id` is dropped (no multi-tenant axis); `namespace` lands as an `ams_namespace` property; ISO `created_at` / `updated_at` are parsed and reused. New CLI verb `memory import ams <dump.json> [--root <dir>] [--json]` wired through `runImport` in `cli.ts`. New `plugins/memory/docs/migrating-from-ams.md` covers the mapping table, the explicit non-features (hosted multi-tenant, REST wire compat, `user_id` axis, LiteLLM-specific provider names), and the export/import/verify steps. New `plugins/memory/tests/fixtures/ams/sample-dump.json` exercises both tiers + a contradiction case. New `plugins/memory/tests/import-ams.test.ts` (6 assertions): heuristic node-type inference; `parseAmsDump` rejects bad shapes; end-to-end sample-dump import lands the right L2 sessions/events/transcript and the right L3 promote/reinforce/contradiction split; contradicting decisions both land with `ams-import` provenance; the importer preserves (or restores) the caller's current session id; re-import is idempotent (duplicates → reinforcement bumps). Full memory suite: 758 passed / 1 skipped. `pnpm typecheck` clean. `pnpm build` clean. Refs #184.

---
## memory — L2 eviction (TTL + byte budget) (added)

- **status**: added
- **upstream**: —
- **why**: Issue #182 (parent PRD #174). L2 working memory (#178) had no bound on session lifetime or byte footprint — abandoned sessions and runaway transcripts accumulated forever. The PRD calls for an eviction sweep that reaps L2 when either age or size exceeds policy.
- **what changed**: New `plugins/memory/src/working-memory-evict.ts` — `evictL2(store, { ttlMs?, byteBudget?, now? })`. Strict L2 filter (`properties.layer === "L2"`); TTL pass first (every L2 node), byte-budget pass second (events only, oldest by `sequence`, transcript survives as the safety net). Each evicted node emits one best-effort `engine.op evict` to `mem.events` (slice #181). L3 is never touched. New `MemoryConfig.l2 = { ttlMs?, byteBudget? }`, `DEFAULT_L2_TTL_MS` (24h), `DEFAULT_L2_BYTE_BUDGET` (16 MiB), and `resolveL2Policy(config)` in `config.ts`. New CLI verb `memory working evict [--root] [--ttl-ms N] [--byte-budget N] [--json]` wired through `runWorking`. Eviction is implemented as a **KV overlay** (`MemoryStore.recordEvicted` / `evictedRids` keyed under `node:evicted:all`) filtered out by `listNodes`, not a physical `DELETE FROM memory_nodes`: the bundled RedDB engine has two delete-related bugs (multi-DELETE on one connection returns `affected: 0` after the first row; the close-and-reopen workaround drops the most-recently-inserted node on the next read) that together make a batched reap unsafe while a session is still writing. The overlay matches the access / reinforcement pattern (ADR 0007); a future engine fix lets us layer real reap on top without changing the consumer-facing contract. New `plugins/memory/tests/working-memory-evict.test.ts` (5 assertions: TTL reaps L2 events leaves L3 + transcript, byte-budget evicts oldest events per session and keeps transcript + L3, `resolveL2Policy` defaults and override + garbage rejection, empty sweep is a no-op). Refs #182.
---

## memory — PromotionEngine (type+dedup gate) + layered triggers (added)

- **status**: added
- **upstream**: —
- **why**: Issue #183 (parent PRD #174). L2 working memory (#178) accumulated typed candidates per session but had no mechanism to promote them into the durable L3 graph. Without a promotion path, every decision/fix/why-note died with the session; doctor and supersession (#179) had nothing durable to operate on for new sessions.
- **what changed**: New `plugins/memory/src/promotion-engine.ts` — pure `(candidates, existing) → (promote, reinforce, skipped)` with a **type gate** (default whitelist `decision`/`fix`/`gotcha`/`validation`/`why_note`/`reasoning`/`solution`/`problem`) and a **dedup gate** (exact-text match, cosine ≥ 0.92 on supplied embeddings, Jaccard ≥ 0.6 on keyword sets — all configurable). No confidence threshold; supersession + doctor handle the long tail. Within one run the engine shadows its own promotions so two near-equivalent candidates collapse to one promote + one reinforce. New `plugins/memory/src/promote.ts` runtime maps L2 working events (`*_candidate` event types → corresponding `NodeType`), runs the engine against L3, then applies decisions: `upsertNode` for promotes, KV reinforcement overlay bump for reinforces (graph collections reject `UPDATE` by rid — ADR 0007, same constraint as the access overlay). Each decision emits one `engine.op` event with `op="promote"` and `outcome="created"|"deduped"` to `memory_events` (slice #181). New `MemoryStore.recordReinforcement(rid)` / `reinforcedCount(rid)` / `reinforcementRecords()` on `graph-store.ts` keyed under `node:reinforce:all`. **Layered triggers**: (1) explicit — `memory promote [--triggered-by ...] [--session ...] [--json]` CLI verb; (2) hook — `Stop` / `PreCompact` flush in `hook-runtime.ts` calls `runPromote({ triggeredBy: "hook" })` after the existing extractor; (3) overflow — `working-memory.appendEvent` fires `runPromote({ triggeredBy: "overflow" })` once a session's sequence crosses `RED_MEMORY_L2_OVERFLOW_THRESHOLD` (default 200). All non-explicit triggers are best-effort and never bubble up. New `plugins/memory/tests/promotion-engine.test.ts` (12 assertions covering no-dup, exact-dup, keyword-near-dup, vector-near-dup, type-filter-rejected, reinforcement-count-increment, batch-internal dedup, type-mismatch, custom promotable set, keyword extraction). New `plugins/memory/tests/promote.test.ts` (4 assertions over promote+event-emission, reinforce-over-double-promote, overflow-backstop, no-session error). Full memory suite: 752 passed / 1 skipped. Refs #183.

---

## afk (engineering) — periodic orchestrator heartbeat into afk.log keeps silent hangs diagnosable (modified)

- **status**: modified
- **upstream**: —
- **why**: Issue #194. On the wQM2K case (#178, 2026-05-26) `afk.log` contained only the two boundary markers (`iteration started` / `iteration stopped`) after a 30-minute hang — the inner-agent stdout that should have been tee'd in (Slice D's "local liveness via stdout tee") never arrived, almost certainly buffered inside the runner pipeline and never flushed before the reaper killed the tree. Result: no forensic surface to tell which stage the worker died in. The boundary markers alone are not a liveness signal.
- **what changed**: New `scripts/lib/heartbeat.sh` (sourced by `afk.sh`) replaces the two inline marker writers. `heartbeat_start` writes the `iteration started` marker *and* spawns a background sub-shell that appends one line per `RED_AFK_HEARTBEAT_S` (default 60s) to `$ITER_LOG`: `[heartbeat] stage:STAGE t+HH:MM:SS last_stream_line="..." cpu=N% rss=NM`. The loop re-reads `current.stage` + `current.last_stream_line` from `afk.state.json` via `state_read_into` on every tick, so the snapshot is always current (mid-iteration stage flips show up in the next heartbeat); `ps` against the orchestrator pid supplies cpu/rss; failure to read state or `ps` is best-effort and never crashes the loop. `heartbeat_stop` SIGTERMs the sub-shell, waits, then writes the closing marker. Because the loop lives in a separate sub-shell from the inner-agent pipeline, a SIGSTOPped inner agent (or a buffered runner tee) no longer silences the log — stage stays frozen, wall-clock keeps advancing. The existing `no-sentinel` envelope's `data-section=log` is the unchanged downstream consumer: `tail_iter_log 50` now carries the periodic heartbeats so the issue thread alone is enough to diagnose where the hang occurred. New `scripts/tests/heartbeat-loop.test.sh` (15 assertions) exercises the format helper, the emit shape against the issue's literal example line, quote-escaping, the live loop with `RED_AFK_HEARTBEAT_S=1` against a SIGSTOPped sleeper (acceptance: forcibly hung worker still produces heartbeats with wall-clock advancing and stage frozen — and a mid-stream `state_write` flips stage in the next tick, proving the loop re-reads state), `heartbeat_stop` reaping the sub-shell deterministically, and the empty-`ITER_LOG` early-return. Refs #194.

---

## afk (engineering) — sup_kill_tree blast-radius guard keeps supervisor alive across reaps (modified)

- **status**: modified
- **upstream**: —
- **why**: Issue #193. #190's hard stall reaper calls `sup_kill_tree` on the orchestrator pid, and in production the supervisor itself died shortly after a reap fired — PID file left behind, slot un-respawned. Root cause: `sup_kill_tree` accepted any value (including `$$`, `0`, negative, non-numeric) and dutifully fanned out `kill`. The orchestrator inherits the supervisor's process group (`nohup` does not `setsid`), so `kill -SIG 0` would target the supervisor's pgrp; a corrupted `SLOT_PIDS[$slot]` pointing at `$$` would trip the supervisor's own `cleanup` SIGTERM trap and exit it cleanly. Both are single-shot foot-guns that take the whole fleet down.
- **what changed**: `sup_kill_tree` now refuses empty / non-numeric / `<=1` / negative pids, and refuses `$$` / `SUPERVISOR_PID` / `BASHPID` — the guards short-circuit before the recursive `pgrep -P` walk and before the final `kill`. A new `SUPERVISOR_PID` is pinned at boot for the live supervisor; sourced tests fall back to `$$` inside the function. Moved `trap cleanup SIGTERM SIGINT` to *below* the source-guard so test harnesses don't hijack their own SIGTERM handler when they `source supervisor.sh`. New `scripts/tests/sup-kill-tree.test.sh` (11 assertions) stages a real `supervisor → orch → grandchild` process tree (no stubs) and asserts: (1) `sup_kill_tree $ORCH` reaps the descendant tree, (2) the supervisor PID survives, (3) every guard refuses cleanly without signalling the supervisor. Without the guard the test exits silently rc=0 via the cleanup trap — proof that the production symptom is reproducible at the unit level. Refs #193.



## afk (engineering) — pnpm PATH shim wraps test invocations in a hard timeout (modified)

- **status**: modified
- **upstream**: —
- **why**: Issue #192. The most expensive recurring AFK failure is a bash-hang where the inner agent starts `pnpm test` via `Bash(run_in_background)` and then enters `until grep "PASS" out.log; do sleep N; done` without a deadline. When vitest hangs (pool exhaustion, IO contention, OOM) the polling loop runs forever; the orchestrator only sees a healthy `claude` process and waits for the supervisor reaper at 30 min. `AGENT-PROMPT.md` already forbade the pattern, but the rule kept drifting — prompt-level constraints cannot outlast LLM drift. Remove the *capability*, not the *permission*.
- **what changed**: New `scripts/lib/inner-shims/pnpm` — a PATH-prepended shim that detects `pnpm test` / `pnpm test:*` (including `pnpm -C dir test`, `pnpm run test`, `pnpm --filter=x test:integration`) and `exec`s `timeout --kill-after=${RED_AFK_TEST_KILL_AFTER_S:-30} ${RED_AFK_TEST_TIMEOUT_S:-300} <real pnpm> "$@"`. The shim re-resolves the real `pnpm` by stripping its own directory out of `PATH`, so it never recurses; non-test verbs (install, build, lint, add, …) are forwarded unwrapped. `RED_AFK_PNPM_SHIM_DISABLE=1` bypasses the wrap. `afk.sh` `run_claude` and `run_codex` prepend `$SCRIPT_DIR/lib/inner-shims` to `PATH` for the inner-agent subshell only, so the deadline is enforced by the binary itself — an untimed polling loop now terminates when the shim's timeout fires the bg test process, not when the supervisor reaper trips at 30 min. New `scripts/tests/pnpm-shim.test.sh` (9 cases — test/run/-C/test:* all hit the 2s synthetic timeout; install/build/add pass through; `RED_AFK_PNPM_SHIM_DISABLE` bypasses; argv forwarded to the real pnpm). `AGENT-PROMPT.md` *Background Tasks and Polling* notes the shim is now the safety net; the prompt rule remains as an explicit "don't build the trap" reminder. Refs #192.



## afk (engineering) — continuous remote-branch push for live iterations (modified)

- **status**: modified
- **upstream**: —
- **why**: Issue #191. `/afk` only pushed the worker branch to origin on terminal failure (the `afk-attempts/*` envelope path). A SIGKILL of the orchestrator before envelope build (supervisor crash, OOM, manual kill) left the iter dir for the next boot's Orphan Cleanup to wipe, losing the diff. We had to manually `git push afk-attempts/...` 6+ times in two sessions.
- **what changed**: New pure module `scripts/lib/remote-branch.sh` with three best-effort helpers — `push_initial` (push HEAD to `refs/heads/afk/{wid}/{N}-slug` with `--force-with-lease` at worktree-create), `install_post_commit_hook` (drop an executable `$worktree/.git/hooks/post-commit` that fire-and-forgets a `git push origin HEAD --force-with-lease` after every inner-agent commit), and `delete_remote` (`git push origin --delete afk/...` on DONE close). All three log a `warn:` and return 0 on failure so they never block the orchestrator. `afk.sh` sources the lib and wires the two write-path calls right after `git worktree add` (process_issue, step 2) and the delete right after `gh issue close --reason completed` (step 10), keeping all other behaviour unchanged. `afk-attempts/*` failure-push namespace is untouched — `afk/*` is now a live-iteration namespace deleted on DONE; `afk-attempts/*` is still the failure-only forensic ref. New `scripts/tests/remote-branch.test.sh` (20 assertions, mocks `git` via PATH override). SKILL.md updates the *Per-Issue Loop* steps 2/10/11 and adds a *Branch namespaces* paragraph in *Terminal-Event Envelope*. Refs #191.



## memory event log skill telemetry dual-write (core)

- **status**: added
- **upstream**: —
- **why**: Give Memory a shared append-only operational telemetry substrate while keeping existing Skill telemetry rollups stable.
- **what changed**:
  - Added a RedDB-backed `memory_events` append-only table with a generic event envelope (`id`, `occurred_at`, `kind`, `source`, `actor`, `scope`, `subject`, `payload`, `provenance`).
  - Added typed `skill.telemetry` payload validation and append/read helpers.
  - `memory event skill` / `ingestSkillEvents` now dual-write raw event-log rows before the existing deduped graph/rollup path, so replayed raw events are auditable without changing current Skill rollup counts.

## memory explicit VCS commit (core)

- **status**: added
- **upstream**: —
- **why**: Let users create auditable RedDB VCS checkpoints for the graph-mode Memory store.
- **what changed**:
  - Added `memory commit` for graph mode, backed by the bundled `red vcs commit` command.
  - The command reapplies Memory tier/versioning policy and reports included versus skipped collections.
  - Repeated runs report `nothing meaningful to commit` when the included durable/reasoning surface has not changed, including when only skipped transient KV metadata changed.

## memory semantic patch anchoring (core)

- **status**: added
- **upstream**: —
- **why**: Make self-improvement proposals more precise by targeting the skill section most related to the observed failure mode.
- **what changed**:
  - Draft `memory-skill-patch` blocks now prefer semantic Markdown sections based on dominant `error_stage` and `error_class`.
  - `verify` failures target Verification/Validation-style sections when present instead of appending to the file tail.
  - Timeout/lock/rate-limit style error classes can target Troubleshooting/Common Pitfalls sections as a fallback.

## memory proposal dedupe (core)

- **status**: added
- **upstream**: —
- **why**: Prevent repeated self-improvement runs from spamming duplicate proposal files for the same failure loop.
- **what changed**:
  - Added deterministic proposal fingerprints based on skill, category, target path, dominant error stage, and dominant error class.
  - `memory improve skills --write-proposal` now refreshes an existing pending proposal with the same fingerprint instead of creating a duplicate.
  - Proposal lifecycle summaries expose `fingerprint`, and write summaries expose `reusedExisting` for automation.

## memory proposal lifecycle (core)

- **status**: added
- **upstream**: —
- **why**: Keep Memory self-improvement proposals reviewable without accumulating stale pending files.
- **what changed**:
  - Added `memory improve proposals list/show/archive` for pending proposal lifecycle management.
  - Archived proposals move under `.red/memory/proposals/archive/<reason>/` with explicit `--yes` and `--reason applied|rejected|stale`.
  - Updated `memory health` to count only pending proposal files, excluding archived history.

## health (memory/core)

- **status**: added
- **upstream**: —
- **why**: Give agents and CI one read-only operational panel before running Memory self-improvement.
- **what changed**:
  - Added `memory health --json` with initialization, graph mode, graph freshness, Skill telemetry, rollup, proposal candidate, high-priority proposal, and pending proposal counters.
  - Included deterministic top proposal summaries and recommended next actions.
  - Added a `health` Skill and registered it in the Memory plugin manifest and README indexes.

## skill-telemetry-partitioned-rollups (memory/core)

- **status**: added
- **upstream**: —
- **why**: Prevent Skill telemetry from exceeding the RedDB KV value limit as more skills/events are observed.
- **what changed**:
  - Store each Skill rollup under its own hashed KV key instead of rewriting one aggregate `skill-rollups:all` blob.
  - Store seen event markers per event ID instead of growing one `skill-events:seen` map.
  - Keep read compatibility with legacy aggregate rollup/seen keys.
  - Added regression coverage for multi-skill telemetry batches that previously failed with `memory_kv` value-too-large errors.

## improve-skills-priority-score (memory/core)

- **status**: added
- **upstream**: —
- **why**: Help agents and CI choose the highest-impact Memory self-improvement proposal first.
- **what changed**:
  - Proposal JSON summaries now include deterministic `score`, `priority`, and `scoreReasons` fields.
  - Scores combine failure ratio, recent failures, repeated error stage/class, and structured patch availability.
  - Proposal summaries are sorted by score descending, then skill name for deterministic tie-breaking.
  - Added unit coverage for priority scoring and ranking plus CLI coverage for JSON priority fields.

## improve-skills-json-evidence-summary (memory/core)

- **status**: added
- **upstream**: —
- **why**: Make Memory self-improvement proposal output easier for agents and CI to route automatically.
- **what changed**:
  - Proposal JSON summaries now include `recentFailures`, `dominantErrorStage`, `dominantErrorClass`, and `patchDrafted`.
  - Added regression coverage for machine-readable evidence summary fields.

## improve-skills-evidence-aware-patches (memory/core)

- **status**: added
- **upstream**: —
- **why**: Make Memory self-improvement proposals more useful by grounding draft patches in concrete failure evidence.
- **what changed**:
  - Proposal generation now reads recent Skill result events and includes failed-event evidence (`error_stage`, `error_class`, `error_code` when present).
  - Draft `memory-skill-patch` blocks now include a targeted troubleshooting note based on the dominant failure stage/class.
  - Added regression coverage proving proposals include evidence and stage-specific guidance without mutating the Skill.

## rtk-workflow-integration (repo)

- **status**: added
- **upstream**: —
- **why**: Make RTK a first-class token-efficiency layer for RedSkills agent work instead of passive setup documentation.
- **what changed**:
  - Added repo agent instructions to prefer RTK-wrapped noisy dev commands when exact raw output is not required.
  - Updated `/context` to report token posture and prefer RTK during context-heavy work.
  - Expanded `/setup-red-skills` RTK setup with hook/instruction installation checks plus explicit fallback usage for agents without hook support.

## improve-skills-structured-patch-draft (memory/core)

- **status**: added
- **upstream**: —
- **why**: Move proposal generation from generic advice toward concrete, reviewable self-improvement patches.
- **what changed**:
  - `memory improve skills --write-proposal` now includes a draft fenced `json memory-skill-patch` block when the target skill can be read and has a safe unique anchor.
  - The generated block stays approval-gated and is still applied only by `memory improve apply <proposal> --yes`.
  - Added regression coverage proving generated proposals include an apply-ready structured patch block without mutating the skill.

## improve-apply (memory/core)

- **status**: added
- **upstream**: —
- **why**: Complete the proposal-gated self-improvement loop with an explicit apply step.
- **what changed**:
  - Added `memory improve apply <proposal-file> --yes` for reviewed structured Skill patches.
  - Added guardrails: proposal and target must stay inside `--root`, proposals need a fenced `json memory-skill-patch` block, and `oldString` must match exactly once.
  - Added tests proving apply is blocked without `--yes` and refuses unstructured proposals.

## improve-skills (memory/core)

- **status**: added
- **upstream**: —
- **why**: Add the first proposal-gated self-improvement write path for Skill telemetry evidence.
- **what changed**:
  - Added `memory improve skills` with dry-run JSON output and explicit `--write-proposal` artifact creation under `.red/memory/proposals/`.
  - Added `/memory:improve-skills` documentation and manifest registration.
  - Added regression tests proving proposal files can be written without mutating Skill source files.

## context-status (memory/core) — read-only context stack healthcheck (added)

- **status**: added
- **upstream**: —
- **why**: Start the next self-improvement slice with a cheap, scriptable context-quality signal before large tasks, graph work, or Skill curation.
- **what changed**: Added `memory status context` plus `/memory:context-status` documentation. The report is read-only and scores agent rules, domain glossary, ADRs, Memory initialization, graph store presence, graph freshness, Skill telemetry, and LLM Wiki readiness while emitting setup recommendations instead of mutating state.

## context (engineering) — RedSkills context stack orchestration (added)

- **status**: added
- **upstream**: —
- **why**: Fold the current best practices from Hermes Agent, Understand-Anything, graphify, and Neo4j Agent Memory into a first-class RedSkills workflow for context management and self-improvement.
- **what changed**: New `plugins/dev/skills/engineering/context/SKILL.md` defines the context stack loop: committed project context (`CLAUDE.md`/`AGENTS.md`, `.red/CONTEXT.md`, ADRs), Memory recall/graph ingest, graph-aware `/zoom-out`, LLM Wiki query/ingest, durable learning capture, and Skill telemetry/curator diagnostics. Registered in the dev plugin manifest, root README, and engineering README.

## memory core skills — expose extract and Skill telemetry diagnostics (added)

- **status**: added
- **upstream**: —
- **why**: The Memory plugin already had the CLI surfaces for transcript extraction and Skill telemetry status, but they were not exposed as documented skills; self-improvement workflows needed first-class command guidance.
- **what changed**: New `plugins/memory/skills/core/extract/SKILL.md` for graph-mode `INFERRED` transcript extraction and new `plugins/memory/skills/core/skills-status/SKILL.md` for read-only Skill telemetry diagnostics. Registered in the memory plugin manifest and README tables. Refreshed stale memory plugin descriptions that still described the markdown-only tracer slice.

---

## zoom-out (engineering) — Impact section splits structural vs observed impact from Reasoning attempts (modified)

- **status**: modified
- **upstream**: —
- **why**: Issue #100 (parent #95). With AFK now recording Reasoning attempts into the Memory graph (ADR 0017) and `zoom-out` already owning Impact analysis (ADR 0018), the Impact section needs to distinguish *what the codebase says today* from *what prior attempts show happened operationally*, without sliding into using attempt history as a product spec.
- **what changed**: `plugins/dev/skills/engineering/zoom-out/SKILL.md` — the optional **Impact** section now carries two explicit sub-bullets: **Structural impact** (imports, calls, containment, type-use, docs links, graph neighbors/paths — verified against the current worktree, unchanged contract) and **Observed impact** (files touched together, repeated blocked / no-sentinel / merge-conflict attempts, retry chains to/away from a successful attempt, validation summaries — framed as *operational history*, explicitly **not authoritative product direction or acceptance criteria**, verified against the worktree before relying on it). Cleanly degrades to structural-only when attempt evidence is absent/stale/empty, and to ordinary code reads when neither is meaningful; raw graph dumps still forbidden and now explicitly cover **attempt records** alongside nodes/edges/paths/recall output. Gather Context gains a paragraph noting that the existing `memory_neighbors` / `memory_recall` calls also surface attempt nodes (`TOUCHED` edges to file nodes, `PRECEDES` between attempts) that feed Observed impact. The section stays read-only — still no `/memory:ingest`, no reindex, no graph/memory writes, no new `/impact` skill, no `memory_impact` primitive. Contract test `plugins/dev/skills/engineering/zoom-out/scripts/tests/contract.test.sh` extended from 18 to 31 assertions: structural/observed sub-bullet labels, observed-impact vocabulary (Reasoning attempts, touched together, repeated, retry chains, validation summaries), operational-history framing, non-authoritative product-direction language, graceful degradation, and the attempt-records no-dump clause. All green. Refs #100.

## zoom-out (engineering) — optional structural Impact section in the Answer Contract (modified)

- **status**: modified
- **upstream**: —
- **why**: Issue #97 (parent #95). When the user's focused area is a file, symbol, module, skill, or concept that may change, the Zoom-out answer should surface a **structural impact surface** — what depends on the target and what the target depends on — without breaking the map-first read-only contract or introducing a new skill.
- **what changed**: `plugins/dev/skills/engineering/zoom-out/SKILL.md` — Answer Contract gains an optional **Impact** section between **Relationships** and **Critical Paths**, defined in terms of imports, calls, containment, type-use, docs links, and graph neighbors/paths, with every claim verified against the current worktree. The section requires graph and recall evidence to be interpreted into project terms (no raw nodes/edges/paths/recall dumps), is **read-only** (no ingest, reindex, graph writes, or memory writes), and explicitly does not introduce a new `/impact` skill or `memory_impact` primitive — it rides on the existing read primitives (`memory_neighbors`, `memory_path`, `memory_recall`) plus ordinary code reads. A trailing paragraph restates the read-only rule for the whole answer. New `plugins/dev/skills/engineering/zoom-out/scripts/tests/contract.test.sh` (18 assertions: section ordering, optional Impact marker, structural-impact vocabulary, worktree-verification requirement, interpret-don't-dump rule, read-only and no-write/no-ingest/no-reindex rules, and explicit prohibitions on a new `/impact` skill or `memory_impact` primitive) — green. Refs #97.

## curate (engineering) — `--background` non-interactive issue filer (modified)

- **status**: modified
- **upstream**: —
- **why**: Issue #94 (PRD #91). Phase 2 of the consent contract: a non-interactive entry point that **never mutates a Skill file** and instead surfaces the same Curatable-skill candidates as a `ready-for-human` Issue. The interactive `/curate` path (or `/afk` against the filed issue) closes the loop later via the existing archive-engine — no new mutation surface is introduced.
- **what changed**: New thin module `plugins/memory/src/curate-skill/issue-filer.ts` — `renderIssueTitle`, `renderIssueBody`, and `fileBackgroundIssue` (the only side effect: shells out to `gh issue create --label ready-for-human --body-file`). Per the slice brief, no dedicated unit test; matches the project's treatment of other `gh`-boundary modules. New `background` subcommand in `plugins/memory/src/curate-skill/cli.ts` — runs the same `precheck` as `list` (so the telemetry-not-enabled prerequisite message is identical to the interactive path), reads `memory curate skills --json`, applies the same `candidate-reader` filtering, and: (a) if the candidate list is empty, exits 0 with **zero outward action** (no issue filed, no comment, no noise), (b) otherwise files **exactly one** Issue grouping candidates by category in the same `stale` → `abandoned` → `frequently-failing` → `archive` order as the interactive view, reusing the glossary vocabulary and per-category evidence string verbatim. `--background` performs zero filesystem mutations of any Skill file under any input — it never invokes `archive` or `restore`. The slice does not introduce a new label vocabulary; it reuses `ready-for-human` as defined by `/setup-red-skills`. SKILL.md gains the `--background` mode section + invocation example; the argument hint advertises the flag. Refs #94.

## curate (engineering) — interactive, archive-only Skill curator (added)

- **status**: added
- **upstream**: —
- **why**: Issue #92 (PRD #91). Tracer slice for the **mutating** Skill curator. Memory's report-only `memory curate skills` surfaces archive recommendations; `/curate` is the user-facing workflow that turns approved Curatable-skill `archive` recommendations into recoverable filesystem moves.
- **what changed**: New skill `plugins/dev/skills/engineering/curate/SKILL.md` — boots with `red-curate-skill check` (fails fast with the exact `memory init --mode graph --skill-telemetry` command when Skill telemetry is off), lists `archive` candidates via the workflow CLI, requires explicit per-name approval, and archives approved Curatable skills via atomic `rename` + per-file SHA-256 manifest. `--restore <name>` reverses the move and hash-verifies every restored file. Three pure modules (`candidate-reader`, `archive-engine`, `consent-gate`) plus the workflow CLI live under `plugins/memory/src/curate-skill/` to share the Memory plugin's tsx / vitest toolchain — the **workflow** itself (and the only entry point that performs the mutation) is the dev-plugin skill, so CONTEXT.md's "skill mutation is a workflow outside the Memory plugin" rule is honoured at the workflow level; the `memory` CLI never invokes archive or restore. The archive engine has a non-destructive `ArchiveFs` interface (no `unlink`/`rm`/`rmdir` member) and is gated by `validateCandidate` so `source_kind` `plugin`/`hub` and `pinned` candidates are refused with a structured rejection *before* any I/O. New bin `red-curate-skill` (`plugins/memory/package.json`). Tests in `plugins/memory/tests/curate-skill.test.ts` cover all three pure modules, the validation gate (no-I/O proof via probing the archive base), a round-trip archive → restore with hash verification, a trip-wire facade proving the engine never reads a destructive fs method, and CLI precondition / empty-approval no-mutation cases. Registered in `plugins/dev/.claude-plugin/plugin.json` (`./skills/engineering/curate`), root `README.md`, and `plugins/dev/skills/engineering/README.md`. Codex's `plugins/dev/.codex-plugin/plugin.json` auto-includes the new directory via `"skills": "./skills/"`. Refs #92.

## afk, triage, diagnose (engineering) — soft-use the `memory` plugin (modified)

- **status**: modified
- **upstream**: afk `—`; triage `e74f006`; diagnose `e74f006`
- **why**: Issue #57 (PRD #49). The `memory` plugin lives on top of `dev` to improve its processes — `/afk` recalling prior attempts/known fixes, `/triage` deduping against known problems, `/diagnose` surfacing past root causes. The integrations had to be wired without making `dev` depend on `memory`: the dependency stays one-directional (`memory` hard-requires `dev`; `dev` only soft-uses `memory`), and all three skills must behave exactly as today when `memory` is absent.
- **what changed**: New shared bridge `plugins/dev/scripts/memory-bridge.sh` — `memory_available <root>` (two gates: `.red/memory/config.json` opt-in **and** a resolvable CLI via `$RED_MEMORY_CLI` → `memory` on PATH → sibling-plugin `dist/cli.js` → in-repo `$MEMORY_REPO_ROOT`) and `memory_recall <root> <query…>` (prints a ranked context block or nothing, **always exits 0** — a missing/uninitialized/erroring memory is an absent optimization, never a failure of the calling dev process). `/afk` AGENT-PROMPT.md Workflow step 1 (Read) recalls before planning; `/triage` Flow B step 1 (Gather context) dedupes recalled known-problems into the Recommend step; `/diagnose` recalls past root causes at the top of Phase 3 (Hypothesise) and stores the new root cause in Phase 6 — each gated, best-effort, silent when `memory` is absent. `dev`'s `plugin.json` deliberately does **not** list `memory` (one-directional guarantee enforced by absence). New `plugins/dev/scripts/tests/memory-bridge.test.sh` (17 assertions: resolution cascade, both detection gates, graceful no-op when absent/uninitialized/erroring, query passthrough) — green. ADR 0009 records the soft-use contract; CONTEXT.md notes the direction on the **Memory plugin** term. Refs #57.

## git-guardrails-claude-code (misc) — make the hook branch-lock aware (modified)

- **status**: modified
- **upstream**: `b8be62f`
- **why**: Issue #65 (PRD #59). The lock was only enforced by the `branch-lock` skill's own hook. A repo running `git-guardrails-claude-code` alone (a common setup) got no lock protection, and ADR 0006 anticipated making git-guardrails lock-aware so either skill enforces the lock. The two had to stay independent — neither importing the other — with an idempotent overlap when both are installed.
- **what changed**: `scripts/block-dangerous-git.sh` gains a second, self-contained layer after the always-on dangerous-pattern block. When an opt-in `./.red/tmp/branch-lock.yaml` is present in the primary checkout, the hook also blocks the branch-leaving / work-loss family — `git switch`/`checkout` to another branch, `switch -`, `checkout -b <new>`, and bare `git stash` — while allowing a switch back to the lock target, targeted file restore (`git checkout -- <path>`), and `git worktree add`. It reads the lock file, resolves scope, and classifies the command **inline** (token-stream scan, compound-command aware), reaching the same verdicts as the branch-lock classifier but **without sourcing or requiring** the `branch-lock` skill (AC3 — no dependency). `/afk` worktrees under `.red/tmp/work-*/` are scope-exempt, mirroring the branch-lock hook so the autonomous loop is never strangled. Absent lock file = silent (opt-in). With both hooks installed the overlap is idempotent: both deny the same commands, neither conflicts (AC2). New `scripts/tests/block-dangerous-git.test.sh` (24 assertions: unchanged dangerous patterns, lock-active branch-leaving/work-loss blocks, same-branch allows, worktree scope exemption, and a no-dependency guard) — green; full branch-lock suite still green (cli 12, classifier 41, lock-store 17, scope-resolver 8, session-start 14). SKILL.md documents the new layer and the no-dependency contract. Refs #65.

## afk (engineering) — honour a PRD/issue pinned branch for base + merge (modified)

- **status**: modified
- **upstream**: —
- **why**: Issue #64 (PRD #59). `/afk` always based worktrees on `origin/main` and merged back into `main`. Work items that target a long-lived feature branch had no way to declare it, so every slice landed on `main` and a human had to move it.
- **what changed**: New pure module `scripts/lib/pin-reader.sh` — `pin_parse_branch` (canonical `branch:` line, list-marker/backtick/quote tolerant, prose-safe), `pin_parse_parent_prd` (`PRD #N` from the `## Parent` convention), and `pin_resolve` (inheritance chain: issue's own pin → parent PRD's pin → `main`). `afk.sh` sources it and adds `resolve_pinned_branch`, the only side effect (fetches the parent PRD body over `gh` only when the issue carries no pin). `process_issue` resolves the pinned branch and bases the worktree on `origin/{pinned}`; `do_merge` gains a `target` param and, when the target is not `main`, switches the primary checkout onto it for the merge/push and **restores `main` on every exit path** (success, conflict-abort, push-reject, hook-abort) so the startup precheck invariant holds. `merge_resolve_conflict` takes the target so its prompt names the right branch. No-pin resolves to `main`, so default behaviour is unchanged. New `scripts/tests/pin-reader.test.sh` (18 assertions: parse + reject-prose, PRD→issue inheritance with override, default-main). Full afk suite green except the pre-existing-RED `statusline.test.sh` (unrelated terminal-escape artifact). ADR 0008 records the merge-to-pinned decision; CONTEXT.md gains the **Pinned branch** term. Refs #64.

## memory plugin — graph mode: core graph-store over RedDB (core)

- **status**: added
- **upstream**: —
- **why**: Issue #52 (PRD #49). Second slice of the `memory` plugin: the RedDB-backed graph storage and the `memory init` path that builds + provisions it locally, so `/memory:store` and `/memory:recall` can run against a typed knowledge graph instead of only flat markdown. Vendors the proven `MemoryStore` from `../red-memory/packages/core` (commit `483034e`) rather than reinventing it.
- **what changed**: Ported `schema.ts` (collections, node/edge taxonomy) and `hash.ts` (content dedupe hash) into `plugins/memory/src/`. New `graph-store.ts` — a `MemoryStore` facade over `@reddb-io/sdk` connecting to a per-project `file://` store: idempotent collection bootstrap, `upsertNode`/`upsertEdge` with KV-backed dedupe, `supersede` (creates a `SUPERSEDED_BY` edge + head-of-chain KV marker), and read paths (`listNodes`, `getNode`, `neighborhood`, `stats`). Writes go through multi-model DML (`INSERT … NODE/EDGE`) and dedupe lives in KV per **ADR 0007** — graph collections reject table inserts and `WHERE`-filter only on `label`/`node_type`, so reads that need rid/content scan client-side. New `graph-recall.ts` — term-scan seeding (FTS over graph properties is unavailable in this engine build) + one-hop neighborhood expansion, dropping superseded nodes. `config.ts` gains `storePath` + `resolveStoreUri`; `init.ts` gains `graphConfig`/`initGraph` (writes config, provisions the store, `reddb: true`, hooks/MCP still off); `cli.ts` routes `init --mode graph` and mode-aware `store`/`recall`. `@reddb-io/sdk` added as a dependency with `pnpm.onlyBuiltDependencies` so the postinstall fetches the bundled `red` binary; no committed `dist/`/`node_modules/`. 7 new vitest assertions against a real `file://` RedDB (CRUD, node + edge dedupe, supersede head-of-chain, init-graph config, store→recall round-trip) — 21 total green; typecheck + build clean; CLI verified end-to-end (init graph → store ×2 dedupes → recall ranks the right node). Out of slice: hybrid mode, MCP server, auto-firing hooks, and the `/afk` · `/triage` · `/diagnose` integrations.

## memory plugin — markdown-only init/store/recall (core)

- **status**: added
- **upstream**: —
- **why**: Issue #51 (PRD #49), tracer-bullet slice. First end-to-end demoable slice of the new `memory` plugin: a persistent, queryable memory for code agents that lives on top of `dev`. Original to reddb.io (ports `../red-memory`); markdown-only is the low-risk path that works with no RedDB and no graph engine.
- **what changed**: New second plugin `plugins/memory/`, mirroring the `dev` layout (`.claude-plugin/plugin.json` + `.codex-plugin/plugin.json` + `skills/<bucket>/SKILL.md`), registered in both marketplace manifests and declaring a hard dependency on `dev`. Self-contained nested TS workspace under `plugins/memory/` (own `package.json`, `tsconfig`, `pnpm-workspace.yaml`, vitest); `dist/`/`node_modules/` gitignored and built at init time. Five small modules with explicit-args, side-effect-free cores: `config.ts` (read/write `.red/memory/config.json`), `init.ts` (markdown-only wizard path — hooks off, MCP off, RedDB not required), `store.ts` (write a fact as a markdown note), `recall.ts` (FTS over the notes, ranked), `cli.ts` (`memory init|store|recall`). Three skills under `skills/core/`: `/memory:init`, `/memory:store`, `/memory:recall`. 14 vitest assertions across init-wizard, recall, and the init→store→recall round-trip — all green; typecheck and build clean; CLI verified end-to-end. `scripts/validate-install-metadata.sh` generalized to validate both `dev` and `memory` (skill-list sync, Claude/Codex version + name parity, both marketplaces expose the plugin, memory declares the `dev` dependency). Out of slice (later PRD #49 work): graph/hybrid storage over RedDB, the MCP server, the auto-firing hooks (SessionStart/PostToolUse/Stop/PreCompact), and the `/afk` · `/triage` · `/diagnose` integrations.

## branch-lock (misc) — change the lock anytime (atomic relock-then-switch)

- **status**: modified
- **upstream**: —
- **why**: Issue #63 (PRD #59). The user must be able to move the lock to another branch at any time without the hook blocking the very move they asked for. `branch-lock.sh set` already did the atomic relock-then-switch (rewrite the target first, then `git switch`), but nothing pinned that contract down — a future refactor could reorder the two steps and silently reintroduce the deadlock.
- **what changed**: New `branch-lock-cli.test.sh` (12 assertions) drives `branch-lock.sh` end-to-end against throwaway repos and locks in the three acceptance criteria: AC1 — `set <new>` from another branch rewrites the lock target *and* lands the working tree on the new branch in one step; AC2 — the intended move is never hook-blocked, proven by showing a raw `git switch <new>` is blocked while the lock still points at the old branch yet `set <new>` succeeds anyway (it relocks first), and that the post-relock state lets the hook allow the very switch the CLI just made; AC3 — locking to the branch already checked out just rewrites the target with no switch. No production code changed — the behavior was already correct; this is a regression guard. Full branch-lock suite green (cli 12, classifier 41, lock-store 17, scope-resolver 8, session-start 14). SKILL.md layout updated to list the new test.

## branch-lock (misc) — SessionStart prompt to offer locking the current branch

- **status**: modified
- **upstream**: —
- **why**: Issue #62 (PRD #59). The lock was opt-in but invisible: nothing reminded the agent the protection existed, so a session would run unlocked unless the user happened to remember `/branch-lock`. This makes the offer the agent's first action.
- **what changed**: New self-contained `branch-lock-session-start.sh` SessionStart hook reusing the same two pure modules as the PreToolUse hook (`lock-store.sh`, `scope-resolver.sh`) so the prompt obeys the exact same scope rule as enforcement. It emits a SessionStart `additionalContext` block instructing the agent to ask whether to lock to the current branch (named) before doing anything else — and never writes the lock itself; a `yes` runs `branch-lock.sh set <branch>`, a `no` leaves the repo unlocked. Stays silent (exit 0, no output) inside `/afk` worktrees (scope exemption), when a lock is already present (nothing to offer), and on a detached HEAD (no branch to lock). New `session-start.test.sh` (14 assertions: should-prompt decision matrix + prompt-text content + end-to-end runs against throwaway repos for primary/locked/worktree). Full branch-lock suite green (classifier 41, lock-store 17, scope-resolver 8, session-start 14). SKILL.md layout + install steps + scope note updated.

## branch-lock (misc) — block the full work-loss git family while locked

- **status**: modified
- **upstream**: —
- **why**: Issue #61 (PRD #59). Extends the classifier so a lock protects against the whole work-losing git family, not just branch switches: a locked agent that runs `git reset --hard` or `git clean -f` would have destroyed work the lock was meant to guard.
- **what changed**: `git-command-classifier.sh` gains four new subcommand families, all gated the same way the branch-switch block already was (active lock, primary checkout — scope/lock logic unchanged in the hook). Blocks: `git stash` / `stash push` / `stash save` (bare stash defaults to push), `git clean` with any force flag (`-f`/`-fd`/`-xfd`/`--force`), `git reset --hard`, and whole-tree restore (`git checkout .`, `git checkout -- .`, `git restore .`). Allows the non-destructive members of each family — read-only stash (`list`/`show`), dry-run clean (`-n`/`--dry-run`), soft/mixed reset, targeted single-file restore (`git restore <path>`, mirroring the already-allowed `git checkout -- <path>`), and `--staged` unstage. The checkout scanner now walks past `--` so `git checkout -- .` is caught while `git checkout -- <path>` stays allowed. 22 new classifier assertions (41 total, all green); hook block message and SKILL.md block/allow tables + scope note updated to match.

## branch-lock (misc) — lock the agent to a branch, block switching away

- **status**: added
- **upstream**: —
- **why**: Issue #60 (PRD #59), tracer-bullet slice. First end-to-end protection of the branch-lock PRD: pin the agent to one branch in the primary checkout and stop it from quietly switching away. Original to reddb.io; extends the `git-guardrails-claude-code` hook pattern without depending on it.
- **what changed**: New skill `plugins/dev/skills/misc/branch-lock/`. Three pure shell modules following the afk `lib/` explicit-args contract — `lock-store.sh` (atomic read/write/clear of gitignored `.red/tmp/branch-lock.yaml`; absent = unlocked), `scope-resolver.sh` (enforce in the primary checkout, exempt `.red/tmp/work-*/` worktrees by toplevel location), `git-command-classifier.sh` (minimal: `git checkout`/`git switch` to a non-lock branch → block; switching back, `git checkout -- <path>`, and `git worktree add` → allow) — each with a `*.test.sh` mirroring the afk harness (lock-store 17, scope-resolver 8, classifier 19 assertions, all green). Self-contained `branch-lock-hook.sh` PreToolUse(Bash) composes the three into an allow/exit-2-block verdict with a clear message. `branch-lock.sh` CLI backs `/branch-lock set|clear|status` (atomic relock-then-switch, lock-store stays the single writer). Added ADR 0006 (agent-only enforcement) and CONTEXT.md glossary terms (Branch lock, Primary checkout, Worktree). Out of slice (later PRD #59 work): SessionStart prompt, `git stash`/`clean`/`reset --hard` blocks, PRD/issue branch pin, git-guardrails lock-awareness.

---

## code-nav (mcp) — LSP-backed code navigation server

- **status**: added
- **upstream**: —
- **why**: Acting on [*How Claude Code works in large codebases*](https://claude.com/blog/how-claude-code-works-in-large-codebases-best-practices-and-where-to-start), which calls LSP integration the high-value addition for large codebases — symbol-level navigation on top of the default agentic search, so the agent stops grepping a name and guessing which match is real.
- **what changed**: First non-skill artifact in the `dev` plugin — an MCP server under `plugins/dev/mcp/code-nav/`. A thin LSP client (`vscode-languageserver-protocol` over stdio) spawns the language server for a file's extension, runs the `initialize` handshake, opens documents lazily, and forwards five MCP tools to LSP requests: `workspace_symbols` (find by name), `goto_definition`, `find_references`, `document_symbols`, `hover`. Config-driven extension→server registry (TS/Go/Rust/Python presets, override via `CODE_NAV_SERVERS`); one server process per language, reused across calls; a missing server binary is skipped without crashing the others. Wired into the plugin via `plugins/dev/.mcp.json` (`mcpServers: "./.mcp.json"` in `plugin.json`, `${CLAUDE_PLUGIN_ROOT}` path). Shipped as a pre-bundled self-contained `dist/index.js` (esbuild) so it runs with zero install; `node_modules` is gitignored. Verified end-to-end against `rust-analyzer` on a fixture crate: all five tools returned correct semantic results (definition at the exact line, both references, full hover signature + doc comment).

---

## handoff (productivity) — redaction guidance

- **status**: modified
- **upstream**: `b8be62f`
- **why**: Issue #36 (upstream drift `67bce91...b8be62f`). Upstream added a redaction instruction to the handoff skill so secrets/PII don't leak into the handoff document.
- **what changed**: Ported only the redaction sentence ("Redact any sensitive information — API keys, passwords, tokens, or PII") into our `/handoff` SKILL.md. Skipped the upstream temp-dir wording (our skill already saves via `mktemp`, i.e. the OS temp dir), the `improve-codebase-architecture` HTML-report rewrite (large, opinionated — defer to a dedicated decision), and the `grill-with-docs/CONTEXT-FORMAT.md` cosmetic tweaks (our `/start` has diverged). Bumped `.upstream` to `b8be62f`.

---

## afk (engineering) — extract lib/history.sh as a deep Module

- **status**: modified
- **upstream**: —
- **why**: Issue #48 (PRD #46). The History ledger (`afk-history.jsonl`, the throughput record the monitor sparkline reads) had its `flock`-serialised append/trim defined in `afk.sh` while `monitor.sh` re-derived the JSONL read schema inline in its own `jq` filter. The wire shape lived in two places — exactly the drift a deep Module prevents.
- **what changed**: Added `scripts/lib/history.sh` following the pure / explicit-args contract of `lib/state.sh` and `lib/merge.sh` — reads no orchestrator globals; the ledger path is a parameter on every call. Three entry points: `history_append <path> <event> [KEY=VALUE]...` (variadic `worker`/`issue`/`runner`/`duration_s`/`merge_sha`/`reason` mirroring `state_write`, optional fields omitted from the record when empty, `flock`-serialised one-record append, JSONL schema defined exactly once in `_HISTORY_APPEND_FILTER`), `history_trim <path> [max_lines]` (`flock`-serialised cap; echoes the cap count when a trim happens so the caller can log it, silent no-op otherwise), and `history_read_done_buckets <path> <from_hour> [buckets]` (the per-hour `done` counts the 48h sparkline needs). `afk.sh`'s inline `history_append`/`history_trim` were removed; a thin `emit_history` adapter wires the Module to the orchestrator's `WORKER_ID`/`HISTORY_FILE` globals, and the six callsites now route through it. `monitor.sh`'s `render_sparkline` sources the Module and consumes `history_read_done_buckets` instead of its hand-rolled `jq` (no second copy of the read schema remains). Emitted ledger bytes are identical to pre-extraction for every event (asserted). New `scripts/tests/history-module.test.sh` (38 assertions: bucketing against a fixture ledger including ignored non-`done` events and dropped out-of-window indices, custom width, missing-file contract; append optional-field presence + numeric `issue`/`duration_s` types + round-trip through the reader; trim cap/echo/no-op) with a `tests/fixtures/history/buckets.jsonl` fixture. All existing afk suites stay green except the pre-existing-RED `statusline.test.sh` (unrelated terminal-escape artifact, `d983094`). Refs #48.

---

## afk (engineering) — extract lib/envelope.sh as a deep Module

- **status**: modified
- **upstream**: —
- **why**: Issue #47 (PRD #46). The `<details data-attempt-status="…">` Envelope schema lived twice — `afk.sh`'s `build_envelope` family and `supervisor.sh`'s hand-rolled `build_discard_envelope` — and the orchestrator carried three near-identical failure-emit blocks (push attempt branch → build diff section → post). Two definitions of one wire shape is exactly the drift a deep Module prevents.
- **what changed**: Added `scripts/lib/envelope.sh` following the pure / explicit-args contract of `lib/state.sh` and `lib/merge.sh` — reads no orchestrator globals, posts via an **injected poster callback** (no hard-wired `gh`), and never writes `envelope.posted`. The `data-attempt-status` schema is now defined exactly once in `envelope_build_body`. Two entry points: `envelope_emit_attempt` (failure family `blocked`/`no-sentinel`/`merge-conflict` **and** the supervisor's `discarded` Envelope — builds per-status sections, pushes the `afk-attempts/{worker}/{issue}-{slug}` branch on the failure path before composing the diff section, posts) and `envelope_emit_done` (section-less success Envelope, no push). `afk.sh`'s `fmt_duration`/`build_envelope_summary`/`build_envelope`/`build_diff_section_body`/`extract_handoff_notes`/`push_attempt_branch` became thin back-compat wrappers; its three failure-emit blocks collapse to one `emit_envelope` call each, and `emit_envelope` is now a Module adapter that keeps ownership of writing `envelope.posted` after a successful post. `supervisor.sh`'s `build_discard_envelope` composes through `envelope_build_body`, and its sweep posts through `envelope_emit_attempt` (second adapter on the same builder). Emitted bytes are identical to pre-extraction for every status (asserted in tests). New `scripts/tests/envelope-module.test.sh` (45 assertions: per-status section ordering, push-success/fail diff bodies, discarded + done shapes, byte-for-byte equality vs `envelope_build_body`, poster-rc propagation) with the post stubbed to a capturing no-op. Existing `envelope-shape.test.sh` (37) and `trip-sweep.test.sh` (39) stay green unchanged. Refs #47.

---

## afk (engineering) — Task mirror Codex sink (native primitive or monitor.sh fallback)

- **status**: modified
- **upstream**: —
- **why**: Issue #45 (PRD #42, ADR `0003`). The native Task mirror is runner-specific, mirroring the `runner-claude.md` / `runner-codex.md` split. #43 shipped the Claude sink (agent-driven `TaskCreate`/`TaskUpdate` consuming `mirror_plan`); a Codex session had no mirror at all and silently fell through. ADR 0003 requires an explicit per-runner adapter — no cross-runner abstraction.
- **what changed**: Added the Codex sink to `scripts/lib/mirror.sh` — `mirror_sink_codex <root> [tracked]` plus its single mockable capability probe `codex_native_task_available` (returns non-zero today; Codex ships no native task surface). Native-available route emits the **same `mirror_plan` call descriptors** the Claude sink applies (reader + reconciler reused unchanged, not reimplemented); no-primitive route falls back to the `monitor.sh` dashboard and prints one notice line, swallowing a `monitor.sh` hiccup so the tick never crashes and emitting zero native calls (no half-state). Always returns 0 (clean degrade). SKILL.md *Task Mirror* gains a binding *Codex sink* paragraph (bare-terminal still skips silently; Codex now falls back rather than skipping); `runner-codex.md` gains a *Task Mirror Sink* section. New `scripts/tests/mirror-codex-sink.test.sh` (11 assertions: default no-primitive, fallback exits 0 + one notice + no half-state, native-mock emits a TaskCreate per live worker and matches `mirror_plan` byte-for-byte, empty-root fallback). No change to `afk.sh`, `monitor.sh`, or the reader/reconciler. Refs #45.

---

## afk (engineering) — Task mirror re-hydrates native tasks on session reopen

- **status**: modified
- **upstream**: —
- **why**: Issue #44 (PRD #42, ADR `0003`). A native task dies with the Claude Code session but the `nohup` AFK worker does not, so a reopened session showed no per-worker tasks until the operator acted. The status bar must recover them automatically.
- **what changed**: No new code path — re-hydration *is* `mirror_plan` (from #43) running cold: on reopen `TaskList` returns no mirror-owned tasks, so the tracked set is empty and the reconciler emits an all-`create` plan over the live state files. Added a *Re-hydration on session reopen* note to the SKILL.md Task Mirror subsection making the contract binding (only `afk.pid`-alive workers re-hydrate; dead workers are untracked-terminal on a cold tick → no ghost task; the next tick is idempotent). Added a 3-assertion re-hydration family to `scripts/tests/mirror.test.sh` (30 total) verifying: reopen recreates each live worker task, dead worker yields no ghost, second tick produces no duplicates. No change to `mirror.sh`, `afk.sh`, or `monitor.sh`. Refs #44.

---

## afk (engineering) — native Task mirror surfaces live workers as background tasks

- **status**: modified
- **upstream**: —
- **why**: Issue #43 (PRD #42). A `/afk` session under Claude Code had only the textual `monitor.sh` dashboard; live workers weren't reflected onto the runner's native task surface, so the user had to keep typing `monitor` to see progress.
- **what changed**: New pure module `scripts/lib/mirror.sh` with three layers — `mirror_read_workers` (state-reader: globs `.red/tmp/work-*/afk.state.json`, verifies liveness via the sibling `afk.pid` with `kill -0`, emits one normalized JSONL record per worker that maps to a task, marking dead-but-named iterations `gone`); `mirror_reconcile` (pure diff keyed by `worker_id:issue` → `create`/`update`/`complete` ops, idempotent across ticks); and `mirror_plan` (maps ops to `TaskCreate`/`TaskUpdate` harness-call descriptors at a single mockable boundary). SKILL.md gains a *Task Mirror (Claude Code only — binding)* subsection under Monitor wiring the sink onto the existing every-3-min `/dev:afk monitor` tick (Codex skips silently). New `scripts/tests/mirror.test.sh` (27 assertions: reader live/dead/idle/partial-state/multi-worker; reconciler cold/advance/idempotent/terminal/drop; plan title+stage mapping and read-only invariant). No change to `afk.sh` orchestration or `monitor.sh`. Refs #43.

---

## afk (engineering) — merge stage integrates moved origin/main, rolls back rejected pushes, dispatches conflict resolver

- **status**: modified
- **upstream**: —
- **why**: Issue #37. `do_merge` fetched `origin/main` but never integrated it, so worker branches merged onto the stale boot-time HEAD and every push was rejected non-fast-forward once origin moved mid-run; the rejected push left an orphan merge commit on local main; and the documented one-shot conflict resolver (SKILL.md per-issue loop step 8) was never implemented (`"no inner self-resolve yet"`).
- **what changed**: New `lib/merge.sh` with two pure git primitives — `merge_integrate_origin` (fast-forward local main onto a moved `origin/main`, or rebase a divergent local snapshot onto it) and `merge_rollback` (reset the checked-out branch to the captured pre-merge tip). `afk.sh` `do_merge` now integrates before merging, captures `pre_merge_sha`, rolls back on push rejection, and on conflict dispatches `merge_resolve_conflict` — a one-shot inner-agent resolver re-entered in the primary checkout with the conflict diff + `git status`, resolving iff no unmerged paths and no `MERGE_HEAD` remain, else falling back to `git merge --abort`. SKILL.md step 8/9 rewritten to match. New `scripts/tests/merge-integrate.test.sh` (19 assertions over temp git repos with a local bare origin: fast-forward integration, divergent rebase, push-rejection rollback, in-sync no-op, missing-ref failure). Out of scope per the issue: supervisor-level fleet coordination. Refs #37.

---

## afk (engineering) — SKILL.md handoff template + README directive-writing docs

- **status**: modified
- **upstream**: —
- **why**: PRD #29 Track A. The two-channel handoff builder (#31) and precedence ladder (#33) shipped, but the operator-facing docs still described the four-element handoff and the old `<human-guidance>` semantics. Operators had no documented way to learn the `<details data-kind="directive">` marker syntax or the authority hierarchy.
- **what changed**: `SKILL.md` *Handoff File Template* now shows the `<thread-discussion>` element in correct position (between `<human-guidance-thread>` and `<agent-notes>`, with `<thread-discussion-entry>` children) and documents the new `<human-guidance>` semantics (one element per extracted directive; two markers in one comment → two siblings). The file-table `handoff.md` row enumerates all five wrappers. Root `README.md` gains a new *Steering a worker mid-flight — directive markers* subsection under `/afk` with a copy-pasteable `<details data-kind="directive">` example, the marker-is-the-authority-gate explanation, and the four-rung precedence ladder summary (`<human-guidance>` > `<issue-body>` > `<previous-attempts>` > `<thread-discussion>`). Docs-only — no script or test change. Refs #34.

---

## afk (engineering) — comment classifier + directive extractor (deep modules)

- **status**: modified
- **upstream**: —
- **why**: PRD #29 #30. Both downstream tracks (A1 directive routing, B1 cap state machine) need a single source of truth for "what kind of comment is this" and "what directives does it carry". Today the predicates are scattered (`envelope_is_envelope`, `comment_is_boot_stamp`, `comment_is_promotion_audit`, `comment_is_heartbeat_glyph`) and directive detection is a private substring peek.
- **what changed**: `afk.sh` gains two pure functions — `classify_comment(body)` returning `envelope` | `directive_carrier` | `thread_discussion` | `audit_noise` (composes the legacy predicates, adds the `directive_carrier` arm, deferring well-formedness to `extract_directives` so the two can never disagree), and `extract_directives(body)` emitting the verbatim content of every well-formed `<details data-kind="directive">…</details>` element NUL-separated in document order (line-oriented parser handling nesting, fenced-code-block `</details>`, attributed/unterminated malformed closes, and CRLF). The legacy predicates stay in place this slice; A1/B1 migrate callers later. New `comment-classifier.test.sh` (26 assertions, no stubs — proving purity). Refs #30.

---

## afk (engineering) — per-issue cap trip handler + supervisor claim-time gate

- **status**: modified
- **upstream**: —
- **why**: PRD #29 Track B (per-issue cap). #32 shipped the `count_blocked_since_guidance` counter; this slice wires it end-to-end so an issue that keeps coming back BLOCKED with no fresh human directive is flipped to `ready-for-human` and skipped instead of burning worker after worker on the same dead loop.
- **what changed**: `afk.sh` gains `per_issue_cap` (reads `RED_AFK_PER_ISSUE_CAP`, default 3, defensive — `0`/non-numeric/negative falls back to 3), `_thread_lacks_directive_marker` (true when the thread has no `<details data-kind="directive">` carrier, so the trip comment teaches the syntax), and `trip_per_issue_cap` (flips `ready-for-agent` → `ready-for-human`, posts a trip comment, appends a copy-pasteable directive-marker self-teaching block when no directive exists; gh failures warn but never crash). `process_issue` gains a claim-time gate: before claiming it fetches comments, counts the trailing BLOCKED run, and on `count ≥ cap` trips and skips the issue without recording a worker spawn. `README.md` operator-tunables table gains a `RED_AFK_PER_ISSUE_CAP` row. `per-issue-cap.test.sh` gains defensive-parsing, marker-detection, and 5 gh-stubbed integration fixtures. Refs #35.

---

## afk (engineering) — AGENT-PROMPT precedence ladder + thread-discussion tie-breaker

- **status**: modified
- **upstream**: —
- **why**: PRD #29 Track A (directive redesign). The handoff now carries a fifth top-level element, `<thread-discussion>` — human-authored comments that did not contain a `<details data-kind="directive">` marker — and the inner agent needs an explicit precedence ladder plus a tie-breaker rule so advisory chatter never gets misread as authority. Without the ladder, two failure modes were observed in PRD #29 dry-runs: agents quoting thread-discussion to override the brief, and agents emitting BLOCKED when an old brief disagreed with newer human guidance (which is exactly the resolution, not a contradiction).
- **what changed**: `AGENT-PROMPT.md` Handoff Anatomy grows from four to five top-level elements; `<thread-discussion>` is documented as advisory-only, lowest authority. New explicit four-rung precedence ladder (`<human-guidance>` > `<issue-body>` incl. HITL body edits > `<previous-attempts>` > `<thread-discussion>`). New tie-breaker rule for `<thread-discussion>` with the two-condition gate — agent may consult it only when (i) the brief is ambiguous AND (ii) no `<human-guidance>` resolves the ambiguity; never to override explicit brief; never to justify BLOCKED. New precedence example showing a `<human-guidance>` comment beating an older acceptance criterion. Existing "latest `<human-guidance>` overrides `<issue-body>`" bullet preserved verbatim. Refs #33.

---

## afk (engineering) — per-issue BLOCKED cap counter (`count_blocked_since_guidance`)

- **status**: modified
- **upstream**: —
- **why**: PRD #29 Track B needs a deterministic per-issue cap so a single stuck issue can't soak the `ready-for-agent` queue with repeated BLOCKED attempts. The cap state is implicit in the comments thread (envelopes + human directives) and must reset cleanly whenever a human hands down fresh guidance.
- **what changed**: new pure function `count_blocked_since_guidance(comments_json) → int` in `afk.sh`. Walks the comments array backwards, counts the trailing run of `data-attempt-status="blocked"` envelopes, and stops on either a `directive_carrier` comment (well-formed `<details data-kind="directive">…</details>` after the audit-noise filter) or a non-blocked envelope (DONE / no-sentinel / merge-conflict / discarded) breaking the trailing-BLOCKED run. `thread_discussion` (narrative) and `audit_noise` (boot stamp / promotion audit / heartbeat / blank) comments are skipped without resetting. Pure: jq only, no `gh`, no filesystem. Private helper `_comment_is_directive_carrier` ships alongside; full classifier consolidation lives in #30 (which downstream slices will use to replace these inline checks). New test suite `per-issue-cap.test.sh` (14 cases) covers all acceptance criteria in isolation. Refs #32.

---

## afk (engineering) — env var rename to `RED_AFK_*` (BREAKING)

- **status**: modified
- **upstream**: —
- **why**: Every env var the skill defined was using ad-hoc prefixes — `TARGET`, `SUPERVISOR_*`, `STALL_*`, `WATCHDOG_*`, `MONITOR_*`, `CARGO_TARGET_BASE`, `GRADLE_USER_HOME_BASE` (operator knobs) and `AFK_*` (hook/detector contract). Two problems: (1) generic names like `TARGET` and `MONITOR_COMPACT` collide with environment vars set by unrelated tools or the operator's shell config; (2) the mix of prefixes made it impossible to grep `env | grep RED_AFK_` to see "everything red-skills/afk is currently seeing." Project-wide convention: all RedSkills env vars start with `RED_*`.
- **what changed**: every env var the afk skill reads or exports is now prefixed `RED_AFK_*`. Hard break — no compat shim, no deprecation warning, no fallback to the old names. Rename map (old → new):
  - Operator tunables: `TARGET` → `RED_AFK_TARGET`, `SUPERVISOR_STAGGER_S` → `RED_AFK_STAGGER_S`, `SUPERVISOR_POLL_S` → `RED_AFK_POLL_S`, `SUPERVISOR_FAST_DEATH_S` → `RED_AFK_FAST_DEATH_S`, `SUPERVISOR_CIRCUIT_K` → `RED_AFK_CIRCUIT_K`, `SUPERVISOR_CIRCUIT_WINDOW_S` → `RED_AFK_CIRCUIT_WINDOW_S`, `STALL_THRESHOLD_SECONDS` → `RED_AFK_STALL_THRESHOLD_S`, `STALL_POLL_S` → `RED_AFK_STALL_POLL_S`, `WATCHDOG_GRACE_SECONDS` → `RED_AFK_WATCHDOG_GRACE_S`, `MONITOR_COMPACT` → `RED_AFK_MONITOR_COMPACT`, `CARGO_TARGET_BASE` → `RED_AFK_CARGO_TARGET_BASE`, `GRADLE_USER_HOME_BASE` → `RED_AFK_GRADLE_USER_HOME_BASE`.
  - Hook/detector contract (exported into each worker's subshell, read by `.red/hooks/*.sh` and shipped detectors): `AFK_SLOT` → `RED_AFK_SLOT`, `AFK_WORKER_ID` → `RED_AFK_WORKER_ID`, `AFK_RUNNER` → `RED_AFK_RUNNER`, `AFK_ISSUE` → `RED_AFK_ISSUE`, `AFK_BRANCH` → `RED_AFK_BRANCH`, `AFK_ITER_DIR` → `RED_AFK_ITER_DIR`, `AFK_ITER_STATUS` → `RED_AFK_ITER_STATUS`, `AFK_MERGE_SHA` → `RED_AFK_MERGE_SHA`, `AFK_MERGE_BASE` → `RED_AFK_MERGE_BASE`, `AFK_DURATION_S` → `RED_AFK_DURATION_S`, `AFK_EXIT_CODE` → `RED_AFK_EXIT_CODE`, `AFK_STATE_FILE` → `RED_AFK_STATE_FILE`, `AFK_PLUGIN_DIR` → `RED_AFK_PLUGIN_DIR`, `AFK_HOOK_ENV_FILE` → `RED_AFK_HOOK_ENV_FILE`.
  - Internal-only shell vars (`PROJECT_ROOT`, `ITER_DIR`, `ITER_LOG`, `STATE_FILE`, `RUNNER`, `WORKER_ID`, `CURRENT_ISSUE`, `CURRENT_BRANCH`, `SKILL_DIR`, `SCRIPT_DIR`) are untouched — they never cross the process boundary so they don't need the prefix.
  - On-disk filenames (`afk-supervisor.log`, `afk-supervisor-defaults.txt`, `afk.pid`, `afk.log`, `afk.state.json`, `afk-attempts/…` branch namespace) are untouched — they are paths, not env vars.
  - Applied across all in-scope files via word-boundary `sed -E "s/\bOLD\b/NEW/g"` (so `TARGET` inside `CARGO_TARGET_BASE` is naturally safe — `_` is a word char, `\b` doesn't fire between letters and `_`): 8 production scripts (`afk.sh`, `supervisor.sh`, `monitor.sh`, `hooks.sh`, `once.sh`, `statusline.sh`, `config.sh`, `lib/state.sh`), 2 shipped detectors (`cargo.sh`, `gradle.sh`), 6 skill-level docs (`SKILL.md`, `SAFETY.md`, `AGENT-PROMPT.md`, `runner-claude.md`, `runner-codex.md`, `detectors/README.md`), root `README.md`, and 13 test suites under `scripts/tests/`. Historical entries in `CHANGES.md` are left alone — they describe past state at the time of the change and should not be revisionist.
- **Migration**: anyone who exported the old names in their shell rc, CI pipeline, project `.env`, or wrapper scripts must rename them. `env | grep -E '\b(TARGET|SUPERVISOR_|STALL_|WATCHDOG_|MONITOR_COMPACT|CARGO_TARGET_BASE|GRADLE_USER_HOME_BASE|AFK_)' | grep -v RED_AFK_` to find leftover settings on the host.
- **Tests**: all 13 afk suites green post-rename — config-loader 33/33, detectors 26/26, envelope-shape 37/37, handoff-builder 53/53, hooks-orchestrator 27/27, lifecycle-hooks 16/16, runner-detection 14/14, sentinel-detection 5/5, stall-detector 16/16, state-accessor 57/57, supervisor-hooks 27/27, trip-sweep 39/39. Pre-existing `statusline.test.sh` case1 failure on `main` unrelated and unchanged.

---

## afk (engineering) — handoff as top-level XML elements (`<issue-body>` / `<previous-attempts>` / `<human-guidance-thread>` / `<agent-notes>`)

- **status**: modified
- **upstream**: —
- **why**: Field reports of inner-agent confusion on multi-attempt issues: the agent couldn't distinguish the issue *body* from issue *comments*, and couldn't distinguish *human* comments from *orchestrator* comments. Root cause was twofold. (1) The handoff used markdown headers (`## Brief`, `## Previous attempts`, `## Human guidance`, `## Notes`) for top-level sections — but the issue body itself is markdown and routinely contains its own `## Notes`, `## Acceptance`, `## HITL decision`, etc. headers, so the section boundaries blurred and the agent had no syntactic guarantee that "this `## Notes`" was the handoff's scratchpad vs. a section the human pasted into the body. `AGENT-PROMPT.md` only documented `## Brief`, leaving the other three sections and the rebuild-per-attempt semantics implicit, so agents fell back to guessing and emitted spurious `BLOCKED` when a HITL decision in a comment "contradicted" an older acceptance criterion in the brief. (2) `build_human_guidance` rendered each block with a bare `_@login · timestamp_` header, but every comment posted from the orchestrator host through `gh issue comment` shows up under the operator's GitHub login — so the displayed author was indistinguishable between orchestrator audits and real human direction.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: `build_retry_handoff_body` now wraps each of the four top-level sections in an XML element instead of a markdown `##` header. Layout: top-of-file frontmatter (`source:` / `prd:` / `runner:` / `started:` / `attempt:`) stays as bare key:value lines, then `<issue-body>…issue body verbatim…</issue-body>`, then optional `<previous-attempts>` containing one or more `<previous-attempt n="N" status="…" worker="…" duration="…" branch="…">` children with `<notes>` / `<drop>` / `<log>` sub-elements, then optional `<human-guidance-thread>` containing one or more `<human-guidance author="@user" at="iso8601">…verbatim comment body…</human-guidance>` children, then `<agent-notes>…</agent-notes>` (with the existing HTML-comment placeholder for an empty scratchpad). `build_previous_attempts` and `build_human_guidance` rewritten to emit the new tag shapes; chronological ordering preserved; the `comment_is_human_guidance` predicate is unchanged (still strips orchestrator audits — boot stamps, promotion lines, heartbeats, envelopes — by body shape, *before* the builder runs, so anything reaching `<human-guidance>` is by construction a human directive). `extract_handoff_notes` rewritten to parse content between `<agent-notes>` and `</agent-notes>` instead of awk-ing past `## Notes`; the placeholder-comment + leading/trailing-blank stripping behaviour is preserved so the `<details data-section="notes">` block on `blocked` / `no-sentinel` envelopes is byte-for-byte identical when no notes were appended.
  - `plugins/dev/skills/engineering/afk/AGENT-PROMPT.md`: rewrote the `## Handoff Anatomy` section to describe the four XML elements (with attribute schemas), state explicitly that the handoff is rebuilt fresh per attempt (so body edits and new comments land automatically), instruct the agent to trust the `<human-guidance>` *tag* over the `author` attribute (gh author-login is indistinguishable between human and orchestrator-posted comments), and codify the precedence rule: most-recent `<human-guidance>` (or HITL edits pasted into `<issue-body>`) overrides older acceptance criteria — disagreement on its own is *not* grounds for `BLOCKED`. Updated the existing references to `## Acceptance` / `## Refs` / `## Suggested Skills` / `## Notes` throughout the file: those markdown sections still exist but they now live *inside* `<issue-body>`, except `## Notes` which became `<agent-notes>` (workflow step 2 and "If You Get Stuck" instruct the agent to append "inside `<agent-notes>`" instead of "a `## Notes` entry").
  - `plugins/dev/skills/engineering/afk/SKILL.md`: rewrote the *Handoff File Template* block to show the new XML structure with annotated children; updated the file-table description of `handoff.md` to enumerate the four wrappers; updated step 3 of the orchestrator loop to describe the XML wrappers; updated the two `## Notes` references in the envelope schema section to `<agent-notes>` (the envelope's `data-section="notes"` block still carries the inner-agent's appended scratchpad — the source is what changed, not the envelope shape).
  - `plugins/dev/skills/engineering/afk/scripts/tests/handoff-builder.test.sh`: case 1's markdown-header assertions (`## Brief`, `## Previous attempts`, `### Attempt 1`, `## Human guidance`, `## Notes`) replaced with XML-tag assertions (`<issue-body>` open/close, `<previous-attempts>`, `<previous-attempt n="1"`, `status="blocked"`, `<human-guidance-thread>`, `<human-guidance author="@alice"`, `<agent-notes>` open/close) and explicit negative assertions that the legacy `## Brief` / `## Notes` headers no longer appear. Case 2's `human_count_2` grep and `attempts_count_2` grep both updated to the new XML anchors. Case 4 (zero-comments) assertions inverted from "no `## Previous attempts` / `## Human guidance` headers, has `## Notes`" to "no `<previous-attempts>` / `<human-guidance-thread>` wrappers, has `<agent-notes>`". Case 5 (malformed envelope) updated to the new XML anchors. New case 6 round-trips the new XML format end-to-end: invokes `build_retry_handoff_body` to write a real handoff to disk, simulates the inner agent appending notes inside `<agent-notes>`, then asserts `extract_handoff_notes` returns the appended text without the placeholder comment, the opening tag, or the closing tag — locks the contract `extract_handoff_notes` has with the new format and proves the `data-section="notes"` envelope block stays byte-clean. 53/53 green (was 45/45 + 8 new).
- **Tests**: handoff-builder 53/53 green. All other afk suites untouched and green (config-loader 33/33, detectors 26/26, envelope-shape 37/37, hooks-orchestrator 27/27, lifecycle-hooks 16/16, runner-detection 14/14, sentinel-detection 5/5, stall-detector 16/16, state-accessor 57/57, supervisor-hooks 27/27, trip-sweep 39/39). The pre-existing `statusline.test.sh` case1 failure on `main` (unrelated — `.red/tmp`-missing branch) is unchanged.

---

## afk (engineering) — supervisor `pre-spawn` + `post-exit` hook integration, monitor `defaults:` header

- **status**: modified
- **upstream**: —
- **why**: Issue #18 landed the generic hook orchestrator and #19 shipped the `cargo` / `gradle` detectors plus a one-shot boot-log line. Issue #21 closes the framework loop on the supervisor side: every worker spawn now drives the orchestrator's `pre-spawn` chain (with `AFK_SLOT` / `AFK_WORKER_ID` / `AFK_RUNNER` / `AFK_PLUGIN_DIR` / `AFK_HOOK_ENV_FILE` populated), every worker termination drives `post-exit` (adding `AFK_EXIT_CODE` and `AFK_DURATION_S`), and the monitor's fleet header surfaces the applied detectors in a new `defaults:` field so the human sees what fired without grepping `.red/tmp/afk-supervisor.log`. End-to-end: a Rust project gets per-slot `CARGO_TARGET_DIR=/opt/cargo-target/slot-N` with zero per-project configuration, and the operator can see that happen at a glance.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/supervisor.sh`:
    - New `PLUGIN_DIR` (parent of `SCRIPT_DIR`) and `DEFAULTS_FILE` (`$TMP_DIR/afk-supervisor-defaults.txt`) constants; new per-slot arrays `SLOT_WORKER_IDS` and `SLOT_APPLIED_DETECTORS`.
    - New `gen_supervisor_wid` returning a `wXXXX` ID for the AFK_WORKER_ID contract — distinct from the runtime ID that `afk.sh` picks for itself.
    - New `write_defaults_file` atomically writes the most-recent applied detector list (newline-terminated, space-separated names) via tmp+`mv -f`. Read by `monitor.sh`.
    - New `run_pre_spawn_hooks SLOT WORKER_ID` fires the `pre-spawn` chain inside a subshell. The subshell snapshots `env` before sourcing `hooks.sh`, runs `hooks_run pre-spawn`, then `comm -13`'s a sorted env diff to isolate exactly the env vars the detectors exported. Caller reads `applied` (basenames) and `env` (`KEY=value` lines) from a freshly-`mktemp -d`'d directory. Detector exports never leak into the supervisor's own environment.
    - New `run_post_exit_hooks SLOT WORKER_ID EXIT_CODE DURATION_S` fires the `post-exit` chain best-effort — stdout/stderr suppressed, non-zero rc logged but never propagated (matches the `post-*` continue-on-error semantics in `hooks.sh`).
    - `spawn_slot` rewritten to (1) generate a worker ID, (2) call `run_pre_spawn_hooks` and abort the spawn (returning the hook rc) on non-zero, (3) build `env_args` from the detector-exported env, (4) append legacy `BUILD_ISOLATION_VARS` overrides so operator-set `CARGO_TARGET_BASE` / `GRADLE_USER_HOME_BASE` still win, (5) `nohup env "${env_args[@]}" "$AFK_SH" "$PROJECT_ROOT" &` as before, and (6) log a canonical `pre-spawn: applied detectors [<names>]` line per spawn (renders `[]` when nothing applied — required for the non-build acceptance criterion). The applied list is persisted to `DEFAULTS_FILE` on every successful spawn.
    - `handle_dead_slot` now reaps the worker zombie with `wait $pid` (`$?` becomes `AFK_EXIT_CODE`; default 0 when `wait` fails — e.g. the pid was already reaped), computes duration as `now - SLOT_SPAWN_EPOCH`, and invokes `run_post_exit_hooks` before the existing fast-death / circuit-trip logic.
    - `log_applied_detectors_boot_line` moved above the source-guard so the function is reachable from unit tests; the body now also calls `write_defaults_file "$applied"` so the monitor's `defaults:` field is correct from the first refresh, even before any slot has spawned.
    - `cleanup` now removes `DEFAULTS_FILE` alongside `PID_FILE` / `CIRCUIT_FILE` so a clean shutdown leaves no stale defaults state behind.
  - `plugins/dev/skills/engineering/afk/scripts/monitor.sh`: `render_fleet_header` reads `DEFAULTS_FILE` and appends a `defaults: <names>` (comma-separated, e.g. `defaults: cargo, gradle`) or `defaults: -` (missing file, empty file, or only-newline content) field to the live `🛡️ supervisor pid=…` line. STALE supervisor + no-supervisor cases are unchanged — the header is still gated on a live pid file.
  - `plugins/dev/skills/engineering/afk/scripts/tests/supervisor-hooks.test.sh`: new — 27 assertions. Exercises `gen_supervisor_wid` format, `write_defaults_file` round-trip, `run_pre_spawn_hooks` against the real shipped detector directory (bare project → empty applied + empty env; Rust project → `cargo` applied + `CARGO_TARGET_DIR=${CARGO_TARGET_BASE}/slot-N` env content + slot dir created; env diff excludes our own `AFK_*` exports; project-local detector returning rc=99 propagates), `run_post_exit_hooks` env contract (`AFK_SLOT` / `AFK_WORKER_ID` / `AFK_EXIT_CODE` / `AFK_DURATION_S` reach the project `post-exit.sh` main hook and the wrapper swallows non-zero rc), `log_applied_detectors_boot_line` seeds `DEFAULTS_FILE` with the applied list (Rust) or empty (bare project), and a tmp-project fixture drives `monitor.sh --once` to confirm the `defaults: cargo, gradle` rendering, the `defaults: -` fallback on empty / missing files, and the header's absence when there's no supervisor pid. Structural greps lock the `spawn_slot` / `handle_dead_slot` wiring (`run_pre_spawn_hooks "$slot" "$worker_id"`, `pre-spawn hook failed` log, `run_post_exit_hooks "$slot" …`, `wait "$pid"`, `AFK_PLUGIN_DIR="$PLUGIN_DIR"`).
  - Tests: new `supervisor-hooks` suite (27/27) + all existing afk suites green — config-loader 33/33, detectors 26/26, envelope-shape 37/37, handoff-builder 44/44, hooks-orchestrator 27/27, lifecycle-hooks 16/16, runner-detection 14/14, sentinel-detection 5/5, stall-detector 16/16, state-accessor 57/57, trip-sweep 39/39. The pre-existing `statusline.test.sh` case1 failure on `main` (script emits a project-basename block when `.red/tmp` is missing; test expects empty) is unrelated and untouched.

---

## afk (engineering) — detector framework, shipped `cargo` + `gradle` detectors, pre-spawn boot-log

- **status**: modified
- **upstream**: —
- **why**: Issue #18 landed the generic three-layer hook orchestrator, and #20 wired the per-iteration lifecycle hooks into `afk.sh`. Issue #19 closes the framework loop on the `pre-spawn` hook point by (a) defining the detector convention as a single short README under a new `detectors/` directory in the skill, (b) shipping two real detectors (`cargo.sh`, `gradle.sh`) that per-worker isolate Rust and Gradle build caches so the fleet never serializes on `.cargo-lock` / Gradle daemon lockfiles, and (c) adding a single boot-log line (`pre-spawn: applied detectors […]`) that surfaces the otherwise-invisible "magic" the first time `/afk` runs on a project. The orchestrator's existing applied-list and config-gating behaviour already supported the convention — this slice ships real detectors that exercise it and wires the announcement into both entry points.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/detectors/README.md`: new — documents the convention. A detector is a single `*.sh` file; first step is an applicability check that `exit 1`s if not applicable (treated by the orchestrator as "skip silently"); if applicable, it writes `KEY=value` lines to `$AFK_HOOK_ENV_FILE` and `exit 0`. Any other exit code is an error (orchestrator aborts on `pre-*` points, logs and continues on `post-*`). Project-local detectors at `<project>/.red/hooks/detectors/*.sh` follow the same convention. Disabling a shipped detector is a single key under `afk.hooks.defaults` in `.red/config.yaml`.
  - `plugins/dev/skills/engineering/afk/detectors/cargo.sh`: new — applies on Rust projects (`Cargo.toml` at `PROJECT_ROOT`). Exports `CARGO_TARGET_DIR=${CARGO_TARGET_BASE:-/opt/cargo-target}/slot-${AFK_SLOT}` so each worker slot compiles into its own target directory. The `mkdir -p` runs before the export so the first run on a fresh host succeeds. `CARGO_TARGET_BASE` overrides the default base path.
  - `plugins/dev/skills/engineering/afk/detectors/gradle.sh`: new — applies on Gradle projects (any `build.gradle*` at `PROJECT_ROOT`) **and** only when the operator has opted in by setting `GRADLE_USER_HOME_BASE` in the supervisor's environment. Without the base var the detector is a no-op (`exit 1`) — deliberate opt-in so the framework never claims a path on the user's filesystem without consent. When both conditions hold, exports `GRADLE_USER_HOME=${GRADLE_USER_HOME_BASE}/slot-${AFK_SLOT}` and pre-creates the directory.
  - `plugins/dev/skills/engineering/afk/scripts/supervisor.sh`: new `log_applied_detectors_boot_line` helper runs the orchestrator's `pre-spawn` chain once at supervisor boot (just before the slot-spawn loop) in a subshell — that way detector exports stay scoped to the announcement and never leak into the supervisor's own env (per-slot env propagation remains owned by `BUILD_ISOLATION_VARS`). When `HOOKS_APPLIED_DETECTORS` is non-empty, the helper writes `pre-spawn: applied detectors [<names>]` via the existing `log` function to `.red/tmp/afk-supervisor.log`. Detectors that exited 1 or were disabled via `.red/config.yaml` are omitted from the line.
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: new `log_applied_detectors_boot_line` helper runs `hooks_run pre-spawn` directly in the worker shell after `bootstrap`, so detector exports propagate to every issue the worker processes. The same boot-line is emitted via the worker's `log` function — captured into `.red/tmp/afk-supervisor-slot-N.log` when the worker was spawned by the supervisor.
  - `plugins/dev/skills/engineering/afk/scripts/tests/detectors.test.sh`: new — 26 assertions. Exercises `cargo.sh` directly (no `Cargo.toml` → exit 1 with untouched env-file; with `Cargo.toml` → exit 0 and writes the correct `CARGO_TARGET_DIR=…/slot-N` line; `CARGO_TARGET_BASE` overrides the default; the target directory is `mkdir -p`'d before writing). Exercises `gradle.sh` directly (no `build.gradle*` → exit 1; present but `GRADLE_USER_HOME_BASE` unset → exit 1; both → exit 0 with the matching `GRADLE_USER_HOME=…/slot-N` line and `mkdir -p` of the home dir). Drives the orchestrator's real shipped detector directory through `hooks_run pre-spawn` to verify `HOOKS_APPLIED_DETECTORS` reports `cargo` on a cargo-only project, drops `cargo` when `afk.hooks.defaults.cargo: false` is set in `.red/config.yaml`, and stays empty on a project with neither marker. Structural greps assert both `supervisor.sh` and `afk.sh` define and call `log_applied_detectors_boot_line` and emit the canonical phrase `pre-spawn: applied detectors`.
  - Tests: new `detectors` suite (26/26) + existing afk suites still green — config-loader 33/33, envelope-shape 37/37, handoff-builder 44/44, hooks-orchestrator 27/27, lifecycle-hooks 16/16, runner-detection 14/14, sentinel-detection 5/5, stall-detector 16/16, state-accessor 57/57, trip-sweep 39/39. The pre-existing `statusline.test.sh` case1 failure on `main` (project-basename block emitted when `.red/tmp` is missing) is unrelated to this slice and untouched.

---

## afk (engineering) — migrate `monitor.sh` and `statusline.sh` to `lib/state.sh` accessor

- **status**: modified
- **upstream**: —
- **why**: Issue #26 landed `lib/state.sh` as the schema-owning accessor for `.red/tmp/work-*/afk.state.json` and migrated `afk.sh` onto it. Issue #27 finishes the migration for the two remaining state-file consumers — `monitor.sh` and `statusline.sh` — so the v1 schema lives in exactly one place. Adding a state field is now a one-line change to `_STATE_JQ_FILTER` in `lib/state.sh`; no consumer needs to learn the JSON shape.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/monitor.sh`: sources `lib/state.sh`. Both `render_worker_compact` and `render_worker` now call `state_read_into st "$state_file"` once per state file (replacing six-to-eight `jq -r` invocations per worker) and read the documented `$st_*` variables. The liveness check (previously `cat .../afk.pid` then `kill -0`) becomes `state_is_live "$state_file"` — afk.sh keeps the state-file `.pid` in sync with the pid file, so both checks resolve identically. The default-value contract is preserved verbatim by mapping the accessor's empty-string defaults back to the original `"-"` sentinels via `${st_field:--}` parameter expansion (compact: `current_n` / `current_title` / `current_stage`; full: same plus `current_worktree`). Per-iteration `elapsed` still prefers `.current.started_at` over `.started_at` via `${st_current_started_at:-${st_started_at}}`. The `avg_s` ETA computation no longer reads the state file directly: `jq -rn --argjson d "${st_durations_seconds:-[]}" '…'` consumes the JSON-encoded array the accessor exposes. No direct `jq` against `afk.state.json` remains. Out-of-scope `jq` calls against `afk-supervisor-circuit.json` (parked/stalled slot rendering) and `afk-history.jsonl` (sparkline) are untouched — those files belong to other modules.
  - `plugins/dev/skills/engineering/afk/scripts/statusline.sh`: sources `lib/state.sh`. The per-worker loop replaces six `jq -r` reads (`pid`, `blocked`, `current.diff_added`, `current.diff_removed`, `current.worktree`, `current.number`) with one `state_read_into st "$state"` plus `state_is_live "$state"` for liveness. The worktree-diff fallback (when `diff_added` / `diff_removed` are both zero) is preserved, including the `git -C "$worktree" diff --shortstat origin/main` shell-out. Issue numbers continue to be filtered via `[[ -n "$st_current_number" ]]` — empty defaults from `state_read_into` are semantically equivalent to the original `// empty` filter. Warm-cache statusline timing on a 2-worker checkout measured 47 ms (was 55 ms before), so the accessor's single-parse-per-file approach is a slight win and well under the 100 ms SLO.
  - Byte-identity verified with hand-rolled fixtures covering live + dead + missing-pid workers and full + partial + empty state files. `diff` of pre- and post-migration `monitor.sh --once` output and `statusline.sh` output is empty for every fixture exercised.
  - Tests: no test files modified. All existing afk suites green — config-loader 33/33, envelope-shape 37/37, handoff-builder 44/44, hooks-orchestrator 27/27, lifecycle-hooks 16/16, runner-detection 14/14, sentinel-detection 5/5, stall-detector 16/16, state-accessor 57/57, trip-sweep 39/39. The pre-existing `statusline.test.sh` failure on `main` (case1 — script emits the project-basename block when `.red/tmp` is missing, test expects empty) is unrelated to this migration and untouched.

---

## afk (engineering) — `afk.sh` per-iteration lifecycle hook integration

- **status**: modified
- **upstream**: —
- **why**: Issue #18 landed the generic orchestrator (`hooks.sh::hooks_run`), but `afk.sh` was still sourcing it without calling it. Issue #20 wires the four per-iteration call sites the orchestrator was built for — pre-iteration, pre-merge, post-merge, post-iteration — into the per-issue loop with the documented env contract. After this slice, projects can drop `.red/hooks/<point>.sh` (or per-layer detectors) and have them run at the right moment without touching `afk.sh`. Claim semantics, worktree layout, and state-file shape are unchanged; the integration is purely additive.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: new `run_lifecycle_hook` helper exports the shared env contract (`AFK_SLOT`, `AFK_WORKER_ID`, `AFK_RUNNER`, `AFK_ISSUE`, `AFK_ITER_DIR`, `AFK_BRANCH`, `AFK_STATE_FILE`, `AFK_PLUGIN_DIR`) then calls `hooks_run`; trailing `KEY=VAL` args become per-call overrides/extras (used by pre-merge to add `AFK_MERGE_BASE`, post-merge to add `AFK_MERGE_SHA`, post-iteration to add `AFK_ITER_STATUS` and `AFK_DURATION_S`). `snapshot_iter_for_hook` + `fire_post_iteration` capture `ITER_DIR` / `STATE_FILE` just before `iter_close_*` zeroes the live cursors, so post-iteration hooks still see the brief-promised paths after cleanup. `process_issue` fires `pre-iteration` immediately after the `running` label edit succeeds and before `git worktree add`; a non-zero hook restores `ready-for-agent`, removes `ITER_DIR`, releases the claim lock, and returns. `do_merge` fires `pre-merge` (with `AFK_MERGE_BASE` from `git merge-base HEAD <branch>`) before `git merge --no-ff` — a non-zero exit funnels through the existing merge-conflict path — and fires `post-merge` (with `AFK_MERGE_SHA`) after `git push origin main`. Every terminal path in `process_issue` (BLOCKED sentinel, no-sentinel, merge-conflict, done, both exhausted-runner exits) now calls `fire_post_iteration` with the matching `AFK_ITER_STATUS` (`blocked` / `no-sentinel` / `merge-conflict` / `done` / `discarded`) and the iteration's wall-clock `AFK_DURATION_S`. Post-iteration hook failures are logged via the orchestrator and do not change the iteration's outcome.
  - `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-hooks.test.sh`: new — 16 assertions. Sources `afk.sh` (with `set +e` to undo `afk.sh`'s inherited `set -e`) and stubs `hooks_run` to record every invocation's exported env vars. Covers: full env contract is exported for pre-iteration; pre-merge carries `AFK_MERGE_BASE`; post-merge carries `AFK_MERGE_SHA`; non-zero rc from the orchestrator propagates back to the caller (so pre-iteration / pre-merge can abort); `fire_post_iteration` replays the snapshotted `ITER_DIR` / `STATE_FILE` after cleanup, sets `AFK_ITER_STATUS` + `AFK_DURATION_S`, clears the per-iteration cursors, and swallows + logs hook failures instead of propagating them. Two structural greps assert `process_issue` covers all five documented terminal statuses and `do_merge` wires both merge hooks; one grep asserts the pre-iteration abort restores `ready-for-agent`.
  - Tests: new lifecycle-hooks suite (16/16) + existing afk suites still green — config-loader 33/33, envelope-shape 37/37, handoff-builder 44/44, hooks-orchestrator 27/27, runner-detection 14/14, sentinel-detection 5/5, stall-detector 16/16, state-accessor 57/57, trip-sweep 39/39. The pre-existing `statusline.test.sh` failure on `main` is unrelated and untouched.

---

## afk (engineering) — extract `lib/state.sh` accessor module + migrate `afk.sh`

- **status**: modified
- **upstream**: —
- **why**: `afk.sh` was the most demanding consumer of `.red/tmp/work-*/afk.state.json` — both reader and writer — and inlined `jq` filters at every callsite. Adding a field (e.g. `current.diff_added`) meant grepping for every reader and writer and patching defaults on each. Issue #26 closes that gap by extracting a schema-owning accessor module that the rest of the AFK toolchain (`monitor.sh`, `supervisor.sh`, `statusline.sh`) can migrate onto in later slices.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/lib/state.sh`: new — exposes `state_read_into`, `state_write`, `state_init`, `state_is_live`. `state_read_into PREFIX path` does a single `jq` invocation, emits `<flat_key>=<@sh-quoted-value>` lines, and sets `${PREFIX}_<key>` shell vars (nested fields like `.current.number` flatten to `current_number`). Defaults are encoded inside the read filter — adding a v1 field is a one-line change. Missing files yield defaults silently; malformed JSON logs a warning to stderr and yields defaults (never aborts the caller). `state_write path key=value key2:=jsonliteral …` composes a single jq filter, writes via `mktemp -p <dir> path.tmp.XXXXXX`, then `mv`s atomically — `:=` flags raw JSON, `=` treats the value as string. `state_init path …` resets to a fresh v1 doc (`version:=1`, `envelope:={posted:false}`). `state_is_live path` returns 0 iff `.pid` is alive via `kill -0` (treats `0` / missing / null as dead).
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: migrated. The local `state_write` / `state_read` / `state_init` / `state_set` functions are gone (~45 LOC removed); `afk.sh` now sources `lib/state.sh` and routes every state-file access through it. Every `state_set "<jq filter>"` callsite became `state_write "$STATE_FILE" field=value …`. The direct `jq -r '.current.number // empty' "$state_file"` and `jq -r '.envelope.posted // false' "$state_file"` lookups in `prune_orphans` and `cleanup` became `state_read_into _orphan "$state_file"` / `_cleanup_current_number` reads. No `jq` invocation that touches a state file remains in `afk.sh`.
  - `plugins/dev/skills/engineering/afk/scripts/tests/state-accessor.test.sh`: new — 57 assertions across two families. Family 1 (fixture reads) covers `v1-full`, `v1-missing-current`, `v1-legacy-no-diff-fields`, and `v1-malformed` (asserts the stderr warning and default-fallback). Family 2 (round-trip writes) covers `state_init` defaults, nested dotted writes (`current.stage=impl`, `envelope.posted:=true`), JSON-literal writes (arrays / `current:=null`), `state_is_live` against live/dead/zero pids, and an atomic-write probe that runs two concurrent writers against one file and asserts the final document parses as JSON with no `.tmp.*` shrapnel left on disk.
  - `plugins/dev/skills/engineering/afk/scripts/tests/fixtures/state/{v1-full,v1-missing-current,v1-legacy-no-diff-fields,v1-malformed}.json`: new fixtures consumed by the test above.

---

## setup-red-skills (engineering) — scaffold `.red/config.yaml` commented template

- **status**: modified
- **upstream**: —
- **why**: PRD #16's hook system and the config loader landed in #17 give consumers a real `.red/config.yaml` schema, but a fresh repo still arrives with no file at all — meaning the user has to read the loader source (or a CHANGES entry) to discover that `afk.default_runner`, `afk.fleet.target`, and `afk.hooks.defaults.{cargo,gradle}` exist. Issue #22 closes that gap: when `/dev:setup-red-skills` runs on a repo missing the file, it drops a fully-commented snapshot of every v1 knob into `.red/config.yaml`. The file is a no-op until the user uncomments a line, but every available override is one ctrl-F away.
- **what changed**:
  - `plugins/dev/skills/engineering/setup-red-skills/config-template.yaml`: new — verbatim seed file the skill copies into the consumer repo. Header comment explains the file's purpose ("per-project plugin settings consumed by `/afk` and friends") and the override rule ("Uncomment any line to override the default"). Body lists every key the loader documents at v1 — `afk.default_runner=claude`, `afk.fleet.target=2`, `afk.hooks.defaults.cargo=true`, `afk.hooks.defaults.gradle=true` — each on its own commented line with the default value and an inline comment explaining the knob. When fully uncommented the YAML is syntactically valid and consumed verbatim by `config.sh`.
  - `plugins/dev/skills/engineering/setup-red-skills/SKILL.md`: new **Section G — `.red/config.yaml` template (automatic)** explainer in step 2, no user decision (auto-scaffold). New write step in step 4 paired with Section G: log `.red/config.yaml already present — leaving as-is` and skip when the file exists; otherwise ensure `.red/` exists and copy `config-template.yaml` verbatim. The skill explicitly does **not** `git add` or commit the file — the user controls when it lands in git, matching the same idempotency / non-clobber rule already in place for `statusLine` (Section F).
  - No script change required — the loader in `plugins/dev/skills/engineering/afk/scripts/config.sh` already handles "file present" vs "file missing" (missing = all defaults), so the scaffolded all-commented file behaves identically to no file at all until the user uncomments something. Existing afk test suites are unaffected (config-loader 33/33 still green); this slice is documentation + a seed file with no runtime code path.

---

## afk (engineering) — generic hook orchestrator + env-file protocol

- **status**: modified
- **upstream**: —
- **why**: PRD #16 needs one place that drives every hook point in the `afk` skill so callers in `supervisor.sh` (pre-spawn / post-exit) and `afk.sh` (pre-iteration / post-iteration / pre-merge / post-merge) don't each re-implement layer chaining, env propagation, and failure semantics. Issue #18 builds that orchestrator: a three-layer chain (shipped detectors → project detectors → project main hook) with a per-invocation env-file protocol so hooks can export values back to the caller, distinct pre vs. post failure semantics (pre aborts; post logs and continues), and an "applied detectors" list other code can render in the boot log.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/hooks.sh`: new — exposes `hooks_run HOOK_POINT` and the `HOOKS_APPLIED_DETECTORS` array. Each subprocess gets its own `mktemp`-allocated `AFK_HOOK_ENV_FILE`; on exit code 0 the file is sourced back into the caller via `set -a; source "$file"; set +a` and then deleted, so vars exported by hooks propagate while temp files never leak. Hook points are hard-coded at v1: pre-spawn / pre-iteration / pre-merge abort on the first non-zero (returning the script's rc); post-exit / post-iteration / post-merge log to stderr and continue. Detector exit code 1 = "not applicable" (never aborts, never applied); any other non-zero is a failure per the pre/post rule. Layers run in C-locale alphabetical order. Layer 1 (shipped) detectors are skipped when `afk.hooks.defaults.<name>` is literally `false` in `.red/config.yaml`; layer 2 (project) detectors are never config-gated. Idempotent via `_AFK_HOOKS_SH_LOADED` guard so both runners can source it.
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: sources `hooks.sh` right after `config.sh` so `hooks_run` is available for the per-iteration / per-merge call sites that will wire up in a later slice.
  - `plugins/dev/skills/engineering/afk/scripts/supervisor.sh`: same — sources `hooks.sh` after `config.sh`, ready for pre-spawn / post-exit wiring.
  - `plugins/dev/skills/engineering/afk/scripts/tests/hooks-orchestrator.test.sh`: new — 27 assertions across the acceptance criteria: empty layers no-op, shipped-detector export propagation, detector exit 1 is N/A (no abort, not applied), shipped exit 2 aborts on pre-spawn but logs-and-continues on post-merge, project detector overrides shipped env value, project main hook overrides both detector layers, alphabetical execution + applied-list ordering across layers, temp env-files cleaned up (counted via private TMPDIR), unknown hook point returns non-zero, main-hook rc propagation on pre-merge vs. swallowed on post-merge, config-driven shipped-detector disable (`cargo: false` in YAML), plus structural checks that both `afk.sh` and `supervisor.sh` source `hooks.sh`.
  - Tests: new hooks-orchestrator suite (27/27) + existing afk suites still green (config-loader 33/33, envelope-shape 37/37, handoff-builder 44/44, runner-detection 14/14, sentinel-detection 5/5, stall-detector 16/16). The pre-existing `statusline.test.sh` failure on `main` is unrelated and untouched.

---

## afk (engineering) — `.red/config.yaml` loader with typed defaults

- **status**: modified
- **upstream**: —
- **why**: PRD #16 needs a single point of truth for per-project plugin settings. Issue #17 carves out the foundational slice: a loader that reads `.red/config.yaml` from the current checkout, merges it over documented defaults, and exposes a typed accessor that downstream modules (runner-detection cascade, fleet supervisor, hook orchestrator) can call without each one re-implementing YAML parsing. Forward-compatibility matters — unknown keys must be silently ignored so older agents tolerate newer configs.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/config.sh`: new — sources cleanly from both `afk.sh` and `supervisor.sh` via an idempotent `_AFK_CONFIG_SH_LOADED` guard. Exposes `config_load [path]` (populates the global `CONFIG_VALUES` assoc-array; missing file → all defaults; malformed YAML → one warning line on stderr, fall back to all defaults) and `config_get KEY` (dotted lookup, e.g. `config_get afk.fleet.target`). Documented v1 defaults: `afk.default_runner=claude`, `afk.fleet.target=2`, `afk.hooks.defaults.cargo=true`, `afk.hooks.defaults.gradle=true`. Parser is a tiny pure-shell scanner — no `yq` dependency — accepting `key: [value]` lines with 2-space indentation, comments (`#`), and single/double quoted scalars. Unknown keys parse fine (stored but unread) for forward compatibility. Malformed detection covers odd-indent and unclosed quotes.
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: sources `config.sh` immediately after computing `SCRIPT_DIR` so every downstream function can call `config_get` without re-parsing.
  - `plugins/dev/skills/engineering/afk/scripts/supervisor.sh`: same — sources `config.sh` right after the discovery block, ahead of any tunables that may later read from config.
  - `plugins/dev/skills/engineering/afk/scripts/tests/config-loader.test.sh`: new — 33 assertions covering missing file (all defaults), partial override (only specified keys replaced), unknown top-level + nested keys (silently ignored, no warning), malformed YAML (unclosed quote and bad indent both fall back with exactly one warning line that names `config.yaml`), every documented v1 default present, nested overrides leaving siblings untouched, integer values round-tripping, comments + blanks ignored, and `afk.sh`/`supervisor.sh` both referencing `config.sh`.
  - Tests: new config-loader suite (33/33) + existing afk suites still green (envelope-shape 37/37, handoff-builder 44/44, runner-detection 14/14, sentinel-detection 5/5, stall-detector 16/16). The pre-existing `statusline.test.sh` failure on `main` is unrelated and untouched.

---

## triage + afk (engineering) — agent brief moves from accumulating comment to issue-body `## Agent brief` section

- **status**: modified
- **upstream**: —
- **why**: Before this change `/triage` posted the AGENT-BRIEF as a fresh GitHub comment on the issue every time it ran. Older briefs were never deleted, so the thread accumulated drift: the most recent comment won, but stale briefs sat indefinitely as silent noise that mis-led human readers (and any future parser tempted to walk the thread). Issue #11 (parent PRD #2) moves the brief to a `## Agent brief` section inside the **issue body**, which `/triage` rewrites in place. Slice C's handoff builder already pipes the issue body verbatim into the inner-agent contract, so the brief rides on the body — no `/afk` code change required.
- **what changed**:
  - `plugins/dev/skills/engineering/triage/AGENT-BRIEF.md`: reframed from "structured comment" to "structured `## Agent brief` body section". Added a *Where it lives in the body* section documenting the canonical body layout (`{arbitrary content} → ## Agent brief → ## Blocked by`, with the noted tolerance that `## Blocked by` may also precede `## Agent brief`). Added an *Editing the issue body* recipe: capture body via `gh issue view --json body`, splice in/replace the section at the next `## ` boundary, write back via `gh issue edit --body-file -`, then leave a one-line disclaimer comment so the thread shows triage touched the issue. Lowercased the section heading to `## Agent brief` across template + three examples to match the canonical key.
  - `plugins/dev/skills/engineering/triage/SKILL.md`: Flow C check now looks for the `## Agent brief` body section instead of "an AGENT-BRIEF on the issue". Outcome table entry for `ready-for-agent` now reads "Write or refresh the `## Agent brief` section in the issue body … Do **not** post the brief as a comment." `ready-for-human` row clarifies the brief lives in the same body slot.
  - `plugins/dev/skills/engineering/afk/SKILL.md`: handoff-file row, per-issue loop step 3, and the handoff template each replaced the "AGENT-BRIEF body" phrasing with "issue body verbatim — which carries the `## Agent brief` section written by `/triage`". No script change — `build_retry_handoff_body` already inlines the issue body under `## Brief`, and `sweep_unblocked`'s awk extractor for `## Blocked by` already tolerates either section order.
  - `plugins/dev/skills/engineering/afk/AGENT-PROMPT.md`: inner-agent prompt's "Inputs" paragraph now points at the `## Agent brief` section inside the body's `## Brief` as the authoritative contract instead of the previous "AGENT-BRIEF posted on the issue" phrasing.
  - `plugins/dev/skills/engineering/setup-red-skills/triage-labels.md` and `.red/agents/triage-labels.md`: `ready-for-agent` state definition rewritten ("issue body contains a complete `## Agent brief` section"); ASCII state-machine diagram updated from `(AGENT-BRIEF posted)` to `(## Agent brief in body)`.
  - `plugins/dev/skills/engineering/report-bug/SKILL.md`: routing note tightened — "AGENT-BRIEF assigned" → "an `## Agent brief` section written into the issue body".
  - Tests: no new tests required. Existing afk suites (envelope-shape 37/37, handoff-builder 44/44, runner-detection 14/14, sentinel-detection 5/5, stall-detector 16/16) still pass — the change is purely documentation/skill-prompt because the handoff pipeline already reads the body verbatim. Legacy `## AGENT-BRIEF` comments on existing issues are intentionally not migrated; they fall through Slice C's classifier into `## Human guidance` of the retry handoff (they look like human prose), and any new `/triage` run overrides by writing to the body.

---

## afk (engineering) — runner detection cascade, opt-in alternate + fallback

- **status**: modified
- **upstream**: —
- **why**: `/afk` historically defaulted `ALTERNATE=1`, silently rotating between `claude` and `codex` on each issue and silently swapping on `RUNNER_EXHAUSTED`. Caller intent was indistinguishable from quota loss — a Claude Code user invoking `/afk` would suddenly find Codex picking up the next issue with no visible cue. Issue #8 (parent PRD #2) replaces the default with caller-aware detection (env-var sniff → path sniff → env fallback), flips alternation to opt-in `--alternate`, and gates exhaustion-swap behind opt-in `--fallback-runner`.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: new `detect_runner` function — pure, accepts an explicit pin + optional script path, echoes `"<runner>|<method>"` so the cascade is testable in isolation. Recognises `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_CODE_SSE_PORT` (claude) and `CODEX_HOME` / `CODEX_SANDBOX` / `CODEX_SANDBOX_NETWORK_DISABLED` (codex); falls through to `*/.claude/*` vs `*/.codex/*` path sniff on `$SCRIPT_DIR`; finally `${AFK_RUNNER:-claude}`. Two new CLI flags — `--alternate` (round-robin on success) and `--fallback-runner` (swap on exhaustion) — both default off; `--alternate` is mutually exclusive with `--runner`. The exhaustion branch in `process_issue` now gates the swap on `FALLBACK_RUNNER`, not on `ALTERNATE`, so the two behaviours are decoupled. Boot log line `runner: <r> (detected via <method>)` fires once per invocation.
  - `plugins/dev/skills/engineering/afk/scripts/tests/runner-detection.test.sh`: new — 14 assertions covering pin-beats-everything, every env-var branch (both runners), both path branches, env-fallback (default and `AFK_RUNNER`), and cascade precedence (env-var beats path).
  - `plugins/dev/skills/engineering/afk/SKILL.md`: rewrote *Bootstrap* step 4 to document the cascade, added flag entries in *When To Use*, rewrote *Runner Fallback* so the new default (no rotation, no fallback) and the two opt-ins are explicit.

---

## afk (engineering) — push attempt branch to `afk-attempts/` on terminal failure

- **status**: modified
- **upstream**: —
- **why**: when an iteration ends in BLOCKED, no-sentinel, or merge-conflict, the diff used to live only on the local worker branch — after `git worktree remove` and `git branch -d` it was gone, leaving the envelope comment with no recoverable code. Issue #9 (parent PRD #2) pushes the branch to `origin/afk-attempts/{wid}/{n}-{slug}` before posting the envelope so investigators can `gh pr checkout` or follow a `compare/main...afk-attempts/...` link from the issue thread.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: new `push_attempt_branch` (SSH push to `afk-attempts/{wid}/{n}-{slug}`, returns the remote ref name or empty on failure), new `branch_diffstat_full` (adds `files=K` to the existing `+N -M`), new `build_diff_section_body` (compare-link when the push succeeded, local-worktree fallback when it failed). Wired into the three terminal-failure paths in `process_issue`; DONE path is intentionally untouched. Push failure logs a `warn:` line but never aborts the iteration.
  - `plugins/dev/skills/engineering/afk/scripts/tests/envelope-shape.test.sh`: stubs `gh_repo` + `branch_diffstat_full` so the diff-section body can be exercised hermetically. Covers both the pushed-link and push-failure-fallback shapes plus envelope-level composition under `data-section="diff"`.
  - `plugins/dev/skills/engineering/afk/SKILL.md`: replaced the "deferred to Slice B" stub with the actual behaviour (when the push runs, what the diff section contains, why DONE is exempt, the no-retention caveat).

---

## afk (engineering) — statusline aggregator + `/setup-red-skills` wiring

- **status**: modified
- **upstream**: —
- **why**: operators running `/afk` had to keep a side terminal open on `/dev:afk monitor` to know how many workers were live and what they were doing. Issue #25 (parent #16) surfaces that summary in the Claude Code statusline — `🤖 N · 📋 ready N · 🙋 human N · 🚧 blocked N · +A -B · #X #Y` — refreshed every few seconds with a cached GitHub round-trip so it stays under the ~100 ms render budget.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/statusline.sh`: opt-out now honours the brief's nested `afk: { statusline: false }` form in `.red/config.yaml` in addition to the legacy top-level `statusline: false`. Aggregator behaviour (kill-0 liveness filter, summed diffstat from `current.diff_*` fields with `git diff --shortstat origin/main` fallback, 60 s cache of `gh issue list` counts in `.red/tmp/statusline-cache.json`, async refresh on stale cache) is unchanged.
  - `plugins/dev/skills/engineering/setup-red-skills/SKILL.md`: new **Section F — `/afk` statusline** explainer + corresponding write step. The skill now (a) skips the wiring when `.red/config.yaml` declares `afk.statusline: false`, logging a one-line notice; (b) skips when `.claude/settings.json` already has a `statusLine` key, logging a one-line notice; (c) otherwise writes/merges the `statusLine` block pointing at `bash ${CLAUDE_PLUGIN_ROOT}/skills/engineering/afk/scripts/statusline.sh` with `refreshInterval: 5`.
  - `plugins/dev/skills/engineering/afk/scripts/tests/statusline.test.sh`: new test (20 assertions) — covers no-`.red/tmp` empty stdout, the one-live-worker render, two-worker summed render, dead-pid filtering, and both opt-out paths. The test pre-seeds `statusline-cache.json` so it never shells out to `gh`. Existing test suites still pass (envelope-shape 27/27, sentinel-detection 5/5, stall-detector 16/16).

---

## afk (engineering) — fleet passive stall detector + monitor `⏸️ stalled` status

- **status**: modified
- **upstream**: —
- **why**: workers stuck on silent resource contention (cargo lock, shared port, deadlocked external service) used to look identical to a healthy `🟢 live` slot in the monitor — operators only noticed when throughput dropped. Issue #23 (parent #16) adds a passive supervisor-side detector that surfaces the condition without taking any action; the operator still owns the decision to investigate / restart.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/supervisor.sh`: added the stall detector. New env knobs `STALL_THRESHOLD_SECONDS` (default `600`) and `STALL_POLL_S` (default `30`). New functions `find_slot_iter_log`, `compute_stalled` (pure predicate for unit tests), `poll_stall_detector`, and `write_supervisor_state` (replaces `write_circuit_state`, additive schema — `{"parked":[…], "stalled":[…]}`, legacy readers consuming `.parked[]?` keep working). The detector samples each non-parked slot's per-iteration `afk.log` mtime on the supervisor's main loop tick; sets `stalled:true` when both `(now − spawn_epoch) ≥ STALL_THRESHOLD_SECONDS` and `(now − log_mtime) ≥ STALL_THRESHOLD_SECONDS`; clears the flag automatically when the log advances. No `kill -TERM` / `SIGKILL` is ever sent for a stalled worker. Added a `BASH_SOURCE` guard so test harnesses can source the file without taking the singleton lock.
  - `plugins/dev/skills/engineering/afk/scripts/monitor.sh`: new `render_stalled_slots` reads `.stalled[]?` from the supervisor state file and prints one row per stalled slot: `slot-N [⏸️ stalled]  stalled for 14m  (check .red/hooks/ — possibly waiting on a shared resource)`. New `fmt_dur_human` helper (`Ns` / `Nm` / `NhMm`). `color_status` gains a `stalled` branch (magenta bold) so the status is visually distinct from `live` (green) / `stale` (yellow) / `parked` (red bold). Agent rendering contract updated with rule #7 covering the new row.
  - `SKILL.md`: Fleet Mode intro now lists the passive stall detector alongside circuit breaker and per-slot build isolation.
  - `scripts/tests/stall-detector.test.sh`: new test (16 assertions) — covers the `compute_stalled` predicate across fresh/recent/silent/no-log/spawn=0/custom-threshold branches, then drives `find_slot_iter_log` + `poll_stall_detector` against a fixture iteration directory to lock the flag/clear cycle and the JSON shape (`stalled[0].slot`, `duration_s`, `parked[]` preserved).

---

## afk (engineering) — Slice D: remove heartbeat-glyph comments from issue threads

- **status**: modified
- **upstream**: —
- **why**: periodic `:one:` / `:two:` / `:three:` / `:four:` glyph comments posted every 10 minutes from a background sub-shell were polluting issue threads and consuming `gh` quota. The thread is now timeline-only (boot stamp, attempt envelopes, human guidance, closing envelope) per the Slice D goal of issue #7 / parent #2.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: removed the heartbeat sub-shell entirely. `heartbeat_start` / `heartbeat_stop` are kept as call-site no-ops that write a single `[heartbeat] iteration started|stopped …` line to `afk.log` so forensic readers can still see iteration boundaries. Removed the `gh issue comment` heartbeat loop and the zombie-heartbeat reaper inside `prune_orphans` — there is no longer a sub-shell to kill. State init writes `heartbeat_glyph: null`, `heartbeat_pid: null` (vestigial fields, retained one release for compatibility).
  - `plugins/dev/skills/engineering/afk/scripts/monitor.sh`: dropped the `heartbeat: <glyph>` field from the per-worker compact view; liveness still derives from PID + state-file mtime.
  - `SKILL.md`: replaced the *Heartbeat Protocol* section with *Heartbeat (local-only, post-Slice-D)* describing the local-only signals; removed the heartbeat sub-shell branch from the Issue Lifecycle diagram and the *Live Header* example; reflected the change in *Per-Issue Loop* step 4, *Orphan Cleanup* step 1, *Terminal-Event Envelope* deferred-work bullets, the State File schema, and the orchestrator abort path. `SAFETY.md`, `runner-claude.md`, `runner-codex.md`: removed "kill heartbeat" language from the signal-handling, abort, and runner-exhaustion paths.

---

## afk (engineering) — structured terminal-event envelope writer + split TTL

- **status**: modified
- **upstream**: —
- **why**: every terminal event of an iteration (BLOCKED, no-sentinel, merge-conflict, DONE) now writes a deterministic `<details data-attempt-status="…">` envelope on the issue so the GitHub thread is the canonical ledger. Foundational write-side slice of issue #6 / parent #2; Slice C will parse these envelopes back.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/afk.sh`: added `build_envelope`, `build_envelope_summary`, `emit_envelope`, `branch_diffstat`, `extract_handoff_notes`, `tail_iter_log`, `fmt_duration`; replaced the four free-form terminal comments with envelope calls; added `envelope.posted` to the per-iteration state file, set `true` after a successful POST, `false` on failure.
  - `prune_orphans` now applies a **split TTL** to preserved `ready-for-human` dirs: 1 day when `envelope.posted == true`, 7 days when `false` or missing.
  - Source-guard added so unit tests can `source` `afk.sh` without invoking the main loop.
  - `SKILL.md`: new *Terminal-Event Envelope* section; *Orphan Cleanup* updated to describe the split TTL; state-file schema gains `envelope.posted`.
  - `scripts/tests/envelope-shape.test.sh`: new test exercising summary/body shape across all four statuses + `fmt_duration` boundary cases.

---

## afk (engineering) — Fleet Mode commands in SKILL.md

- **status**: modified
- **upstream**: —
- **why**: the supervisor existed but had no user-facing entry point in the skill — operators had to know to run `bash scripts/supervisor.sh` and touch `.red/tmp/afk-supervisor.stop` by hand, and the auto-monitor cron from `/afk` was never torn down explicitly. The new `/dev:afk fleet [N]` / `/dev:afk fleet stop` section documents the launch/stop contract, the single-supervisor refusal, the Codex unsupported message, and the cron teardown handshake. Closes #4.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/SKILL.md`: new *Fleet Mode (Claude Code only — binding)* section before *Monitor* describing the two subcommands. Launch flow: runner check → PID-file pre-check → `nohup env TARGET=N bash scripts/supervisor.sh` → schedule auto-monitor cron (deduped against existing entry) → report PID, log path, stop command. Stop flow: runner check → liveness check (missing / stale / alive) → touch `.red/tmp/afk-supervisor.stop` → bounded 30s wait for PID file to disappear → `CronList`/`CronDelete` every `/dev:afk monitor` entry. Idempotency clarified — re-running stop after a clean exit is a no-op.
  - `argument-hint` frontmatter extended with `fleet [N] | fleet stop | monitor`.
  - *When To Use* gained two bullets for the new subcommands.

---

## afk (engineering) — supervisor per-slot build-isolation env vars

- **status**: modified
- **upstream**: —
- **why**: build tools that serialize on a single cache directory (cargo's `.cargo-lock`, Gradle's daemon caches, etc.) force concurrent fleet workers into 20+ minute stalls or CPU/RAM starvation when they share `/opt/cargo-target`. Per-slot subdirectories let each worker compile in isolation. The operator opts in by setting a `*_BASE` env var; non-Rust / non-Gradle projects see zero filesystem side effects.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/supervisor.sh`: new `BUILD_ISOLATION_VARS` table mapping `*_BASE` env vars to the per-worker var the supervisor exports (`CARGO_TARGET_BASE` → `CARGO_TARGET_DIR`, `GRADLE_USER_HOME_BASE` → `GRADLE_USER_HOME`). New `build_slot_env_overrides` helper computes `${BASE}/slot-{i}` for each set base var, `mkdir -p`s the directory, and emits `KEY=value` lines. `spawn_slot` collects them into an `env` argv and prefixes the worker invocation, so per-slot env never leaks into other slots or the supervisor itself. Slot indices are stable across respawns because `spawn_slot` is always called with the same slot number. Top-of-file comment documents the supported base vars and how to add a new tool.

---

## afk (engineering) — supervisor circuit breaker + monitor parked rendering

- **status**: modified
- **upstream**: —
- **why**: a misconfigured runner that fast-fails workers (auth broken, missing dependency, panic-on-startup) could burn cycles indefinitely — the supervisor respawned them blindly. The circuit breaker parks the slot after K=5 fast deaths inside a 90s window so other slots keep working while the operator fixes the broken runner. The monitor surfaces parked slots so the fleet shrinkage is visible.
- **what changed**:
  - `plugins/dev/skills/engineering/afk/scripts/supervisor.sh`: per-slot fast-death ring buffer (tunable via `SUPERVISOR_FAST_DEATH_S` / `SUPERVISOR_CIRCUIT_K` / `SUPERVISOR_CIRCUIT_WINDOW_S`, defaults `30s` / `5` / `90s`). Worker death within `< FAST_DEATH_THRESHOLD_S` of spawn counts as a fast death; entries older than the window are pruned on each pass; hitting K parks the slot, logs `🔥 slot N parked after K fast deaths in 90s — fix runner & restart`, and writes `.red/tmp/afk-supervisor-circuit.json`. Parked slots are skipped in the respawn loop until the supervisor restarts; the circuit file is cleared both on shutdown and on a fresh `acquire_lock`.
  - `plugins/dev/skills/engineering/afk/scripts/monitor.sh`: new `render_parked_slots` reads the circuit JSON and emits one `slot-N [⛔ parked] fast_deaths=… last_death=…` row per parked slot in both TTY and compact modes. `[⛔ parked]` joins the existing `[live]` / `[stale]` / `[dead]` palette. Agent rendering contract updated to require surfacing parked rows verbatim with a `/dev:afk fleet stop` recommendation.

---

## afk (engineering) — monitor renders supervisor header

- **status**: modified
- **upstream**: —
- **why**: when the fleet supervisor is running, `monitor.sh` gave no indication that a fleet was up — operators had to `cat .red/tmp/afk-supervisor.pid` and `pgrep` by hand to verify. The new header surfaces supervisor state at a glance and distinguishes live from stale supervisor PID files.
- **what changed**:
  - new `render_fleet_header` function in `plugins/dev/skills/engineering/afk/scripts/monitor.sh`. Reads `.red/tmp/afk-supervisor.pid`; when the PID is alive, parses `target=N` from `afk-supervisor.log` and counts live workers by walking the latest `slot N: spawned worker pid=PID` entry per slot and probing `kill -0`. Emits `🛡️ supervisor pid=… target=N alive=M/N`.
  - stale PID file (process gone) renders `⚠️ supervisor pid=… STALE — run /dev:afk fleet stop to clean up` instead.
  - no PID file → nothing emitted; non-fleet usage is unchanged.
  - header rendered in both TTY (`render_full`) and compact (`render_compact`) modes, immediately above the 48h sparkline.

---

## afk (engineering) — fleet supervisor with respawn

- **status**: modified
- **upstream**: —
- **why**: foundational slice for PRD #1 (multi-worker `/afk` fleet on a single checkout). Until now, running N concurrent workers meant N manual `nohup afk.sh &` invocations and no respawn when one died. The supervisor lets a single process maintain `TARGET` workers, with a single-supervisor lock so accidental double-launches are refused.
- **what changed**:
  - new `plugins/dev/skills/engineering/afk/scripts/supervisor.sh`. Spawns `TARGET` (env, default `2`) `afk.sh` workers via `nohup`, redirects each to `.red/tmp/afk-supervisor-slot-N.log`, polls liveness every 15s with `kill -0`, respawns dead slots. Stagger between initial spawns is 2s.
  - single-supervisor invariant via `.red/tmp/afk-supervisor.pid`. Second invocation against a live PID refuses with a clear error and non-zero exit. Stale PID (process gone) is cleared and the new supervisor proceeds.
  - graceful shutdown on `SIGTERM` / `SIGINT` / touch of `.red/tmp/afk-supervisor.stop`: TERMs all workers, removes the stop-file if present, exits 0.
  - `afk.sh` is discovered relative to `$BASH_SOURCE`, so plugin upgrades and worktree layouts don't break the script. Workers are unchanged — same claim-lock, same state files, same per-iteration contract; the supervisor only manages process lifecycle.

---

## to-prd (engineering) — surface HITL decisions

- **status**: modified
- **upstream**: —
- **why**: PRDs blended human calls with agent synthesis under one `Implementation Decisions` heading. Once `/to-issues` slices a PRD and `/afk` picks up the children, the human's load-bearing choices become indistinguishable from agent inference — and they get lost.
- **what changed**:
  - new `## Human Decisions` section in the PRD template, sitting above `Implementation Decisions`. Each entry uses `Decision:` / `Why:` / `Alternatives considered:` (mirrors the `Why:` / `How to apply:` shape we already use in feedback memories and ADRs).
  - step 2 reinforced: every HITL call from the conversation that produced the PRD must be captured explicitly in `Human Decisions`. Not optional, not a free-form chat artifact.
  - `Implementation Decisions` remains for agent-side synthesis (module shapes, schemas, API contracts inferred from the codebase).

---

## afk (engineering) — auto-monitor loop + self-cancel

- **status**: modified
- **upstream**: —
- **why**: drainers were manually invoking `/dev:afk monitor` every few minutes to check progress, or setting up `/loop 3m /dev:afk monitor` by hand. The agent already has session-scoped cron primitives (`CronCreate` / `CronList` / `CronDelete`) — the skill can drive them automatically and free the user from babysitting.
- **what changed**:
  - new "Auto-Monitor Loop (Claude Code only — binding)" section in `afk/SKILL.md`. When `/afk` spawns a worker, the agent now also runs `CronCreate(cron="*/3 * * * *", prompt="/dev:afk monitor", recurring=true)` so the dashboard surfaces every 3 minutes for the rest of the session. Dedupe via `CronList` so a second parallel `/afk` doesn't double-schedule. Skipped for `/afk monitor` (not a spawn) and `/afk --once` (single supervised iteration). Falls back gracefully when running under Codex (no Cron tools available).
  - new "Self-Cancel" subsection in *Monitor*. Every monitor invocation — user-typed or cron-fired — counts `[live]` workers in its own rendered output. When zero live workers remain, the agent calls `CronList` / `CronDelete` to remove any `prompt == "/dev:afk monitor"` job, and appends `🛑 no live workers — auto-cancelled monitor loop` to the output. The cron is session-only, so worst case a stale cron dies with the session anyway.
  - shell scripts unchanged — `afk.sh` and `monitor.sh` can't invoke session-level tools, so the entire lifecycle lives in the skill prose the LLM reads.

---

## afk (engineering) — sentinel watchdog + polling discipline

- **status**: modified
- **upstream**: —
- **why**: production wheel-spin observed across multiple `/afk` iterations. Inner agent emits `<promise>DONE</promise>`, but a background tool call (`run_in_background pnpm test` followed by `until grep "test result" $out; do sleep 5; done` polling without a timeout) keeps the stream-json pipe open. The bg task crashed silently, the loop runs forever, the inner agent can't terminate because the tool call is still active, the orchestrator hangs in `anon_pipe_read` for hours. Manual `kill <bash-pid>` resolves it.
- **what changed**:
  - **Watchdog (defensive)** in `scripts/afk.sh`. New `kill_tree` helper (recursive pgrep + SIGTERM, 5 s grace, SIGKILL). New `run_sentinel_watchdog` background process spawned alongside every inner-agent pipeline; tails the raw stream capture for `<promise>(DONE|BLOCKED)</promise>`, then gives `WATCHDOG_GRACE_SECONDS` (default 30) for the pipeline to close. If still alive, kills the whole tree. Both `run_claude` and `run_codex` rewired to launch the pipeline in background and wait for the watchdog-managed exit. `run_codex` gains a `$raw` capture tee so the watchdog has a json stream to scan (was previously only available for claude).
  - **Polling discipline (preventive)** in `AGENT-PROMPT.md`. New binding section "Background Tasks and Polling" forbids the `until grep "test result"` pattern outright, prescribes foreground `timeout --kill-after=30 N cmd` as the default, and requires every fallback polling loop to carry a `$SECONDS`-based deadline plus a `<promise>BLOCKED</promise>` exit when the deadline trips.
  - **Docs.** New "Sentinel Watchdog" section in `afk/SKILL.md` describing the failure mode, the watchdog's grace + kill order, the env override, and the cross-reference to the prompt-side rule.

---

## urgent (engineering) + afk: urgent prepend in issue selection

- **status**: added (skill) + modified (afk)
- **upstream**: —
- **why**: needed a "do this now" lane that does not depend on `/triage` or the standard priority labels. `priority:high` already saturates from time to time and an urgent fix shouldn't have to wait its turn behind other high-priority work. Adds a budget label users spend sparingly.
- **what changed**:
  - new `skills/engineering/urgent/SKILL.md` with a two-question interview (what's urgent / why now), pushback rule when "why now" is weak (suggest `/report-bug` or `/triage` instead), and `gh issue create --label priority:urgent --label ready-for-agent`. Skips `needs-triage` by design. Auto-creates the `priority:urgent` label if it does not exist (colour `B91C1C`).
  - `scripts/engineering/afk/scripts/afk.sh` `select_issues`: splits the candidate pool into urgent / non-urgent, applies `--prd` / `--issues` only to the non-urgent remainder, then concats `[urgent (sorted by number asc)] + [filtered]` with a number-based dedupe so an urgent that also matched the filter does not appear twice.
  - `afk/SKILL.md` Issue Selection rewritten to document the urgent prepend as a hard rule that runs before any filter.
  - registered in `plugins/dev/.claude-plugin/plugin.json`, engineering bucket README, root README skill table.

---

## report-bug (engineering)

- **status**: added
- **upstream**: —
- **why**: bug capture flow was bouncing between users opening rough GitHub issues by hand (no template, missing repro / expected behaviour) and going through full `/triage` which is too heavy for the "first hand off" step. Needed a lightweight reporter that interviews the user, normalises the body, applies `type:bug` + `needs-triage`, and stops — `/triage` handles the rest.
- **what changed**:
  - new `skills/engineering/report-bug/SKILL.md`
  - frontmatter `argument-hint: "[symptom — leave empty to seed from conversation]"`
  - boot behaviour: argument → seed for "What's happening"; empty → mine conversation transcript for error messages, stack traces, recent commands, "this is weird"/"why is it doing"/"I expected … but got" phrases.
  - interview loop follows `Q##:` numbering + `Branches:` template established by `/start` and `/reflect`. Fills the issue template fields in order: what's happening, what should happen, reproduction, context (when/where/what i was doing/environment), severity.
  - filing: `gh issue create --label type:bug --label needs-triage`. Refuses to set priority, slice, or `ready-for-agent` — that's `/triage`'s contract.
  - hard rules: do not invent repro steps, do not file more than one issue per invocation, sanitise body for ANSI / secrets, route the user to `/triage` after creation but do not call it.
  - registered in `plugins/dev/.claude-plugin/plugin.json`, `plugins/dev/skills/engineering/README.md`, root `README.md` engineering table.

---

## global: Codex marketplace metadata + runner doctor

- **status**: modified
- **upstream**: —
- **why**: RedSkills already ran well in Claude Code, but Codex CLI installs could drift because the repo only shipped Claude marketplace metadata and the manual linker only targeted `~/.claude/skills`.
- **what changed**:
  - Added `.agents/plugins/marketplace.json` and `plugins/dev/.codex-plugin/plugin.json` so Codex can load the same `plugins/dev/skills/` tree natively.
  - Updated `scripts/link-skills.sh` to link stable skills into `~/.claude/skills`, `~/.agents/skills`, and `~/.codex/skills`.
  - Added `scripts/validate-install-metadata.sh` and wired it into `red-release` to catch drift between published skill directories and install manifests.
  - Added `scripts/doctor-runners.sh` to verify Claude/Codex runner flags, Codex marketplace registration, and manual symlink installs without calling a model.
  - Updated `red-release` to keep the Claude and Codex plugin versions in sync.
  - Registered the stable `misc/` skills in `plugins/dev/.claude-plugin/plugin.json`, matching the repo rules and README reference table.

---

## afk (engineering) — Claude/Codex runner compatibility

- **status**: modified
- **upstream**: —
- **why**: the shell runner already used unattended Claude permissions, but the runner documentation still described the older `acceptEdits` mode and the inner-agent prompt used Claude-style `/skill` phrasing in places that Codex also reads.
- **what changed**:
  - `runner-claude.md` now documents the actual `--permission-mode bypassPermissions` invocation and handoff path contract.
  - `AGENT-PROMPT.md` now tells inner agents to use the runner-native skill invocation style (`/skill` for Claude Code, `$skill` or installed skill lookup for Codex).

---

## red-release workflow — conventional-commit-driven semver + plugin.json sync

- **status**: modified
- **upstream**: —
- **why**: prior workflow always bumped patch and never touched `plugins/dev/.claude-plugin/plugin.json`, so the manifest `version` field drifted from the git tags and consumers had no semver signal.
- **what changed**:
  - Parses commits since the last tag for `feat!:` / `fix!:` / `BREAKING CHANGE` (major), `feat:` (minor), `fix:` (patch). No matching commits → skip release entirely.
  - Writes the new version into `plugin.json`, commits it back to `main` with `[skip release]` to avoid recursion, then tags and creates the GitHub Release.

---

## afk (engineering) — claim race fix

- **status**: modified
- **upstream**: —
- **why**: `gh issue edit --remove-label A --add-label B` is not atomic — gh resolves the new label set client-side and submits the union, so a removed-but-no-longer-present label is a silent no-op and exit code stays 0. SKILL.md previously claimed atomicity, which was false: two parallel `/afk` runners could both think they owned an issue.
- **what changed**:
  - New `claim_lock_acquire` / `claim_lock_release` helpers backed by `mkdir .red/tmp/claims/{N}/` (POSIX-atomic on a single checkout). `iter_close_success` / `iter_close_preserve` release automatically, so every terminal path (success, blocker, exhausted, SIGINT) cleans up.
  - `process_issue` now: (1) acquires the local lock, (2) pre-checks via `gh issue view --json labels` that `ready-for-agent` is present and `running` is absent, then (3) runs the existing edit. Either gate failing → release lock and skip.
  - `prune_orphans` sweeps stale claim locks at boot: any `.red/tmp/claims/{N}/pid` whose pid is dead gets reclaimed automatically.
  - Rejected the reporter-suggested post-verify (sleep + re-view): two racers both pass it because the final label state is idempotent. False confidence is worse than no check.
  - SKILL.md atomicity paragraph rewritten to document the three-layer scheme and the residual multi-clone / multi-host gap.

---

## afk + to-prd + to-issues + triage-labels — PRD guard + worktree relocation

- **status**: modified
- **upstream**: —
- **why**: two recurring failure modes in the AFK loop. (1) PRDs were being labelled `ready-for-agent` and picked up by `/afk`, which cannot implement them. (2) Each agent placed its worktree somewhere different — some used `../.workspaces/…` (sibling to repo), some inlined under the repo — causing confusion and stale directories outside the project tree.
- **what changed**:
  - **PRD guard**: new permanent label `type:prd` (applied by `/to-prd`, never removed) and new state label `needs-slicing` (applied by `/to-prd`, removed by `/to-issues` once children exist). `/to-prd` no longer applies `ready-for-agent` — that was the bug. `/afk` hard-filters `type:prd` from its candidate list and warns when one is found. `/to-issues` removes `needs-slicing` from the parent after publishing slices. Straggler check counts `needs-slicing`.
  - **Worktree relocation**: per-iteration directory now lives at `.red/tmp/work-{id}-i{N}/` inside the primary checkout (gitignored). It contains `worktree/`, `afk.pid`, `afk.log`, `afk.state.json`, `drop.md` — one self-contained unit per (worker, issue). Removed on success, preserved on blocker. Replaces the prior `../.workspaces/{repo}-{id}-{N}` sibling layout that drifted between agents.
  - `scripts/afk.sh`: worker ID generation in bootstrap, per-iteration `iter_open`/`iter_close_*` helpers, cross-iteration aggregates kept in shell vars and re-snapshotted into each per-iteration state file.
  - `scripts/monitor.sh`: globs `.red/tmp/work-*/afk.state.json` and renders one section per live iteration, marking dead `afk.pid` as `stale`.
  - `SKILL.md`, `SAFETY.md`, `AGENT-PROMPT.md`, `runner-claude.md`, `runner-codex.md`: drop file path is now `../drop.md` relative to the worktree (i.e. one level up inside the iteration directory).

---

## repo layout — marketplace + `dev` plugin

- **status**: modified (repo-wide restructure)
- **upstream**: —
- **why**: rebrand the single plugin from `red-skills` → `dev` so the marketplace can host additional sibling plugins later (`data`, `ops`, …) under the same `reddb-io/red-skills` repo
- **what changed**:
  - `skills/` → `plugins/dev/skills/` (`git mv`, history preserved)
  - `.claude-plugin/plugin.json` → `plugins/dev/.claude-plugin/plugin.json`; plugin `name` is now `dev`
  - root `.claude-plugin/marketplace.json` plugin entry now points `source: "./plugins/dev"` with name `dev`
  - install command becomes `/plugin install dev@red-skills` (was `red-skills@red-skills`) — **breaking for already-installed users; reinstall required**
  - README links, CLAUDE.md structure section, `scripts/link-skills.sh` updated for the new path

---

## triage, tdd, diagnose, to-issues (engineering) — body restructured with `<what-to-do>` / `<supporting-info>`

- **status**: modified
- **upstream**: `e74f006`
- **why**: companion to the [/start](#start-engineering--renamed-from-grill-with-docs) rewrite and the new SKILL.md body convention in `CLAUDE.md`. These four skills are long-bodied and prone to model drift (skipping repro, horizontal slicing, publishing without quizzing, hypothesising without a feedback loop). Frontloading the imperative directive and demoting reference/templates makes the core loop dominate.
- **what changed** (in each):
  - body wrapped in `<what-to-do>` (primary imperative) + `<supporting-info>` (reference, formats, templates)
  - explicit numbered steps with mandatory-gate language ("do not proceed until…")
  - hard DO/DON'T list using ✅/❌ — anti-patterns called out by name (horizontal slicing in tdd, skipping repro for bugs in triage, hypothesising without a loop in diagnose, publishing without user approval in to-issues)
  - reference docs, role tables, templates, and prose explainers moved to `<supporting-info>`

## setup-red-skills + README: RTK as recommended companion

- **status**: modified
- **upstream**: —
- **why**: long `/afk` runs (and engineering work generally) burn a large fraction of tokens on noisy CLI output — `pnpm install` progress, verbose `git status`, `gh` JSON. [RTK](https://github.com/rtk-ai/rtk) is a transparent hook-layer CLI proxy that saves 60–90% on routine dev ops with zero changes to skill code. Strong recommendation, not a hard dependency.
- **what changed**:
  - `setup-red-skills/SKILL.md`: new Section E — Token efficiency, with install command, verification steps, and the `rtk-ai/rtk` vs `reachingforthejack/rtk` name-collision warning
  - `README.md`: new "Before a long /afk run — install RTK" callout under Setup, with install one-liner and the same name-collision warning
  - skill overview list now mentions "Token efficiency" as a setup dimension

## caveman (productivity)

- **status**: removed
- **upstream**: `e74f006`
- **why**: maintainer preference — caveman mode adds noise to the maintainer's chat; the user prefers full sentences. The skill is available globally via the `caveman` plugin if anyone wants it.
- **what changed**:
  - removed `skills/productivity/caveman/`
  - de-registered from `.claude-plugin/plugin.json`, root `README.md` reference table, `skills/productivity/README.md`

## global: repo content fully translated to English

- **status**: modified (cross-cutting policy)
- **upstream**: —
- **why**: reddb.io policy — 100% of committed repo content (SKILL.md files, READMEs, CHANGES.md, CLAUDE.md, ADRs, templates, examples, workflow comments) must be in English. Keeps the skill library shareable, contributor-friendly, and consistent with upstream. User chat may stay Portuguese — the repo cannot.
- **what changed**:
  - translated to English: `CLAUDE.md`, `README.md` (root), `CHANGES.md`, `.red/CONTEXT.md`, `skills/engineering/setup-red-skills/SKILL.md` Section A explainer, all of `skills/knowledge/` (`README.md`, `wiki-init/SKILL.md`, `wiki-init/schema-template.md`, `wiki-init/index-template.md`, the four `page-template-*.md`, the two `examples/*.md`, `wiki/SKILL.md`, `wiki/REFERENCES.md`)
  - English-only rule documented in `CLAUDE.md` rules list

## global: workflow filenames prefixed `red-`

- **status**: modified
- **upstream**: —
- **why**: clear namespace for workflows shipped or owned by RedSkills, separating them from a host project's own CI workflows
- **what changed**:
  - `.github/workflows/upstream-watch.yml` → `red-upstream-watch.yml` (and `name:` field updated)
  - convention enforced going forward — see `feedback_red_workflow_prefix` memory and `setup-red-skills/workflows/` templates

## global: label naming convention (kebab-case or `prefix:value`)

- **status**: modified
- **upstream**: —
- **why**: consistent vocab makes labels easy to scan in the UI, easy to grep, and easy to filter with `gh issue list --label`. No uppercase/Camel/snake/space-separated labels.
- **what changed**:
  - `triage-labels.md` auxiliary labels: `prd-{N}` → `prd:{N}`; HITL/AFK routing is represented by lifecycle labels instead
  - `afk/scripts/afk.sh` PRD filter updated to match `prd:N`
  - naming convention section added to `setup-red-skills/triage-labels.md`

## setup-red-skills (engineering) — renamed from setup-redskills

- **status**: renamed-from-setup-redskills
- **upstream**: — (second internal rename; the original was `setup-matt-pocock-skills`)
- **why**: consistency with the rest of the vocab — RedSkills is logically two words (`red-` is the namespace prefix); skill, plugin, and workflows now share the same pattern (`red-skills`, `red-issues-needs-triage`, etc.)
- **what changed**:
  - directory `skills/engineering/setup-redskills` → `setup-red-skills`
  - frontmatter `name: setup-redskills` → `setup-red-skills`
  - live refs in `plugin.json`, `engineering/README.md`, `.red/CONTEXT.md`, `.red/adr/0001-*.md`, `to-prd/SKILL.md`, `to-issues/SKILL.md`, `triage/SKILL.md`, `afk/SKILL.md`, `in-progress/review/SKILL.md`, `wiki-init/SKILL.md`
  - historical entries in `CHANGES.md` preserved with the old name (they document the past)

## setup-red-skills: workflows shipped to consumer repos (auto-triage)

- **status**: modified
- **upstream**: `e74f006`
- **why**: close the "lost issue" gap — issues created outside the `/to-issues` flow arrive unlabelled and stay invisible to `/triage` and `/afk` (which filters on `ready-for-agent`). The workflow auto-applies `needs-triage` to every `opened`/`reopened` issue with no labels.
- **what changed**:
  - new `skills/engineering/setup-red-skills/workflows/red-issues-needs-triage.yml` (template installed into `.github/workflows/` of the consumer repo)
  - `setup-red-skills/SKILL.md`: new Section D — Workflows; step 4 copies `workflows/red-*.yml` into `.github/workflows/`; creates the `needs-triage` label if missing
  - convention: all workflows shipped by RedSkills use the `red-` filename prefix (clear namespace vs the consumer project's own CI)

## setup-red-skills: canonical lifecycle + priorities high/low

- **status**: modified
- **upstream**: `e74f006`
- **why**: `setup-red-skills/triage-labels.md` is the single source of truth for the label vocab — added a full lifecycle (ASCII state machine), the `running` label (consumed only by `/afk`), the heartbeat protocol, and auxiliary labels (`bug`, `enhancement`, `priority:high|low`, `prd:N`). `/afk` SKILL.md references the canonical doc and only shows its own slice. Priorities reduced to two (`high`/`low`) — less hesitation in triage.
- **what changed**:
  - `setup-red-skills/triage-labels.md`: rewritten with mapping table + ASCII state machine + state definitions + heartbeat protocol + auxiliary labels + naming convention note
  - `afk/SKILL.md`: new section "Issue Lifecycle (the `/afk` slice)" with a focused diagram; references the canonical doc
  - `afk/scripts/afk.sh`: `cleanup()` on SIGINT/SIGTERM now releases the claim (`running` → `ready-for-agent`) and posts a comment; issue sort simplified to `priority:high` before the rest; PRD filter now looks for `prd:N` label instead of `prd-N`

## afk (engineering, new skill, original to reddb.io)

- **status**: added
- **upstream**: —
- **why**: we needed a single autonomous entry point that: (1) integrates with GitHub Issues (label `ready-for-agent`), (2) runs in isolated worktrees so it never touches the primary checkout, (3) coordinates state via labels + comments + heartbeat, (4) alternates runners (claude/codex) on rate-limit, (5) delivers responsive feedback (live header + monitor + state file).
- **what changed**:
  - new `skills/engineering/afk/` with `SKILL.md`, `AGENT-PROMPT.md`, `SAFETY.md`, `runner-claude.md`, `runner-codex.md`
  - `scripts/afk.sh` (main loop), `scripts/once.sh` (debug single iteration), `scripts/monitor.sh` (readonly state board)
  - filters: `--prd N`, `--issues N,N,N`, default = all `ready-for-agent`; flags `--runner`, `-n`, `--once`
  - drop file format follows the `handoff` style in `.red/tmp/drop-{N}-{slug}.md` (gitignored); references over duplication
  - atomic state file at `.red/tmp/afk-state.json`; monitor reads, orchestrator writes
  - heartbeat sub-shell `:one:` → `:four:` every 10 min via `gh issue comment`
  - merge-back with auto-snapshot when primary is dirty; conflict = `ready-for-human`, worktree preserved
  - runner exhaustion → automatic mid-issue swap; both exhausted → exit 75
  - straggler check at startup: warns about unlabelled / `needs-triage` / `needs-info` issues and (on a TTY) prompts before draining
  - registered in `plugin.json` and `README.md`

## knowledge/ (new bucket) + wiki-init + wiki (new skills, original to reddb.io)

- **status**: added
- **upstream**: — (not from Matt; Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern)
- **why**: bring an incremental, LLM-maintained knowledge accumulation pattern into RedSkills, distinct from RAG and from the technical glossary (`.red/CONTEXT.md`)
- **what changed**:
  - new bucket `skills/knowledge/` with `README.md`
  - `skills/knowledge/wiki-init/` — bootstrap (SKILL.md, schema-template.md, index-template.md, 4 page templates, 2 examples under `examples/`)
  - `skills/knowledge/wiki/` — operations (SKILL.md, REFERENCES.md with Karpathy/Memex/Tolkien Gateway/qmd/Obsidian Dataview/Web Clipper/Zettelkasten)
  - policies: layout `.red/wiki/{raw,pages,index.md,log.md}` + schema at `.red/agents/wiki.md`; kebab-case names; frontmatter `title/type/tags/created/updated/sources`; `.red/wiki/` 100% gitignored; isolated from CONTEXT/ADR; search via index+grep with future migration to qmd
  - registered in `.claude-plugin/plugin.json`, root `README.md`, and `CLAUDE.md`
  - **C4 diagram (complexity-gated)**: optional `.red/wiki/C4.md` holds the system's C4 model (Context / Container / Component, level 4 omitted). Wiki proposes creation when ≥3 services or non-trivial integration appears during ingest or query. Ingest workflow adds step 6 "C4 awareness" — check whether the new source introduces architectural surface not yet on the diagram, update if so and bump `updated:`. Lint gains check #7 "C4 staleness" — flag when sources newer than the diagram's `updated:` touch named containers/components. Mermaid blocks use plain `flowchart` (universally rendered) instead of experimental `C4Context`/`C4Container`/`C4Component`. The content around each diagram (actors, containers, components, relationships, tech choices) is the substance — the diagram is just the index — and every named element must already exist in `.red/CONTEXT.md`; new terms surface a glossary update before going into C4.md.

## reflect (productivity) — renamed from grill-me

- **status**: renamed-from-grill-me
- **upstream**: `e74f006`
- **why**: reddb.io vocab — "reflect" conveys intent without the aggressive tone of "grill"
- **what changed**:
  - directory `skills/productivity/grill-me` → `reflect`
  - `name:` frontmatter → `reflect`; description adjusted (trigger "reflect" instead of "grill me")
  - refs in `plugin.json`, `README.md`, `skills/productivity/README.md`, `skills/engineering/triage/SKILL.md`, `skills/engineering/improve-codebase-architecture/SKILL.md`, etc.

## start (engineering) — renamed from grill-with-docs

- **status**: renamed-from-grill-with-docs
- **upstream**: `e74f006`
- **why**: reddb.io vocab — this is the kickoff skill for any non-trivial work
- **what changed**:
  - directory `skills/engineering/grill-with-docs` → `start`
  - `name:` frontmatter → `start`
  - refs in `plugin.json`, `README.md`, `skills/engineering/README.md`, `improve-codebase-architecture/SKILL.md`, `triage/SKILL.md`, `setup-redskills/domain.md`, etc.
  - body rewrite (tags kept as `<what-to-do>` / `<supporting-info>`): frontloaded an explicit loop, hard DO/DON'T list, and a question-format template so the interview behaviour dominates over the documentation side-effects. CONTEXT/ADR rules demoted to "trigger" subsections instead of equal-weight tasks (model was drifting into docs mode instead of grilling).
  - **input contract**: added `argument-hint: "[plan to grill: prose, URL, path, or empty]"` so users see in autocomplete that the skill accepts a plan/context payload. Empty arg opens with `Q01: what plan are we grilling?`.
  - **eager wiki ingest**: external refs (URL / file path) in the boot argument *or* mid-grilling delegate to `/wiki ingest <ref>`. Receipt line on turn 1 (`Fetched … → wiki/raw/<slug>.md`) gives the user visibility that the material was actually read. When `/wiki` is not initialised, prompts once for `/wiki-init`; on decline, falls back to plain `WebFetch`/`Read` with receipt marked `(not cached)`.
  - **question numbering**: every question is prefixed `Q##:` (zero-padded, session-scoped, reset on each `/start`). Gives the user a sense of grilling depth and a stable handle for later reference.
  - **enumerated branches**: question template now requests a `Branches:` block with `(a)/(b)/(c)` options whenever the decision space is finite, and `Recommend:` references a branch letter (`Recommend: (a), because …`) instead of restating prose. Lets the user answer with a stable handle (`ok (b)`, `(c) but with X tweak`) and forces the skill to make the choice space explicit instead of hand-waving. Branches block is opt-out for genuinely open-ended questions.

## global: GitHub Issues as the only supported tracker

- **status**: modified (cross-cutting policy)
- **upstream**: `e74f006`
- **why**: reddb.io policy — issues and PRDs always on GitHub, never local; removes branching for local-markdown, GitLab, Jira, Linear
- **what changed**:
  - removed `skills/engineering/setup-redskills/issue-tracker-local.md` and `issue-tracker-gitlab.md`
  - `setup-redskills/SKILL.md` Section A rewritten: GitHub only, no "Local markdown" / "GitLab" / "Other"; explorer no longer looks for `.red/scratch/`
  - `setup-redskills` description and overview updated
  - `skills/in-progress/review/SKILL.md` step 2: removed refs to `GitLab !67` and `.red/scratch/`

## global: `.red/` namespace for artefacts in consumer repos

- **status**: modified (cross-cutting)
- **upstream**: `e74f006`
- **why**: keep client repos clean and identifiable — every artefact produced or consumed by RedSkills lives under `.red/` rather than polluting the root with `CONTEXT.md`, `docs/adr/`, `docs/agents/`, `.scratch/`
- **what changed**:
  - `CONTEXT.md` → `.red/CONTEXT.md`
  - `CONTEXT-MAP.md` → `.red/CONTEXT-MAP.md`
  - `docs/adr/` → `.red/adr/`
  - `docs/agents/` → `.red/agents/`
  - `.scratch/` → `.red/scratch/`
  - applied across every skill in `engineering/`, `in-progress/`, and the root files (`CLAUDE.md`, `README.md`, this repo's own `CONTEXT.md` and `docs/adr/`)

## setup-redskills (engineering)

- **status**: renamed-from-setup-matt-pocock-skills
- **upstream**: `e74f006`
- **why**: Matt's name doesn't fit a plugin called `redskills`
- **what changed**:
  - directory `skills/engineering/setup-matt-pocock-skills` → `setup-redskills`
  - heading `# Setup Matt Pocock's Skills` → `# Setup RedSkills`
  - references in `to-prd`, `to-issues`, `triage`, `review`, `engineering/README.md`, `docs/adr/0001-*.md` updated

## deprecated/ (bucket)

- **status**: removed
- **upstream**: `e74f006`
- **why**: reddb.io decision not to ship dead skills
- **what changed**: removed all of `skills/deprecated/` (ubiquitous-language, qa, design-an-interface, request-refactor-plan)

## personal/ (bucket)

- **status**: removed
- **upstream**: `e74f006`
- **why**: skills tied to Matt's personal setup, not applicable to reddb.io
- **what changed**: removed all of `skills/personal/` (edit-article, obsidian-vault)

## scaffold-exercises (misc)

- **status**: removed
- **upstream**: `e3b90b5`
- **provenance**: upstream-derived from `mattpocock/skills`; imported during the dev-plugin marketplace restructuring (`7792235`) and later removed in `8e02ac2` / `a49666c`.
- **why**: upstream AI Hero / Total TypeScript course-exercise scaffolder (targets `pnpm ai-hero-cli internal lint` + an `exercises/` tree); irrelevant to reddb.io engineering.
- **what changed**: deleted `plugins/dev/skills/misc/scaffold-exercises/`; removed from `plugins/dev/.claude-plugin/plugin.json`, the root `README.md` table, and the `misc/` bucket README. `.codex-plugin` drops it via its `./skills/` wildcard.

## codebase-design (engineering)

- **status**: skipped — folded into improve-codebase-architecture
- **upstream**: `6eeb81b`
- **why**: The deep-module vocabulary is referenced by exactly one skill (`improve-codebase-architecture`), so a standalone shared-vocabulary skill adds indirection without serving a second consumer. All upstream content already exists in the ICA skill directory: the vocabulary (`codebase-design/SKILL.md` ≡ `LANGUAGE.md`), the deepening guide (`DEEPENING.md`), and the design-it-twice pattern (`DESIGN-IT-TWICE.md` ≡ `INTERFACE-DESIGN.md`).

## upstream drift acknowledgement — mattpocock/skills `21f5976..272f99b` (46 commits, 24 files)

- **status**: reviewed, cherry-picked nothing
- **upstream**: `272f99b`
- **why**: RedSkills has diverged completely from mattpocock/skills (own dev/memory/brain ecosystem; not a fork). All upstream additions in this range either have a RedSkills equivalent or are Matt-specific: `research` → `deep-research` / `dev:research`; `wayfinder` (renamed from `decision-mapping`) → no RedSkills equivalent needed; `claude-handoff` → `dev:handoff`; `implement` → `dev:simple-code` / `dev:complex-code`. Minor tweaks to grilling/tdd/ask-matt/setup docs are likewise not applicable.
- **what changed**: bumped `.upstream` sha from `21f59763be7bf734cd4cf138805bb653d9ffebb7` to `272f99b22574f50e4266791c86b9302682970e23`; no skill files added, modified, or removed.
- **what changed**: no files added, removed, or modified; upstream `codebase-design` skill recorded here as not adopted.

## manager (engineering)

- **status**: added
- **upstream**: —
- **why**: Spec #2290 slice #2291 — the Manager's first functional slice needs an operator surface for the walking skeleton (start an effort, persist it, render its status brief) per ADR 0109.
- **what changed**: added `plugins/dev/skills/engineering/manager/SKILL.md` (wrapper over `red-skills-dev manager`); registered it in `plugins/dev/.claude-plugin/plugin.json`, the root `README.md` skill map, and the `engineering/` bucket README; added the `/manager` route and inventory entry to `ask-red`; regenerated the Codex manifest.

## hitl, triage, retake, dashboard, daily-review (engineering) — MCP-first client rewrite

- **status**: modified
- **upstream**: —
- **why**: ADR 0120 made red-castle's `castle` MCP the canonical interface, but these five castle-verb skills still hand-rolled the flows (raw `gh` label flips in `/hitl` and `/triage`) or invoked the `red-skills-dev` CLI as the primary path — outside the doc-contract test's bijection, so they drifted silently.
- **what changed**: each SKILL.md now names its castle tools as the primary surface with the CLI as documented fallback — `/hitl` → `requeue` + `hitl_resolve`, `/triage` → `triage`, `/retake` → `retake` + `requeue`, `/dashboard` → `dashboard`, `/daily-review` → `daily_review`/`weekly_review`; `apps/dev/tests/castle-mcp-client-docs.test.ts` gained a per-skill routing assertion binding all five to the tool surface.

## afk, go, to-spec, to-tickets, start (engineering) — territory scoping via tag labels

- **status**: modified
- **upstream**: —
- **why**: several humans run fleets against ONE shared `ready-for-agent` pool; without territory scoping any fleet grabs any ticket (a backend-tuned fleet doing frontend work badly). New `tag:<value>` label family + author filter partition the pool without binding issues to users.
- **what changed**: `/afk` gained `--tags a,b` (selector `tags` facet — AND over `tag:<v>` labels, untagged issues excluded from tag-scoped fleets) and `--user login|@me` (issue author facet, `@me` resolved to a concrete login at dispatch/persist time); `/go` gained `--tags` stamping the labels on the minted `lane:go` issue (auto-created when missing); `/to-spec` and `/to-tickets` gained `--tags` with Spec→Ticket inheritance and on-demand `gh label create`; `/start` records `--tags` as a session decision for the downstream Spec; `triage-labels.md` documents the `tag:<value>` auxiliary family; fleet selectors (`fleet.md`, MCP `fleet_*`/`queue_status`) carry the new `tags`/`user` facets.
