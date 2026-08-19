# Design — token-efficient browser automation for `/verify` and frontend workflows

Design/scoping output for issue #992 (Track 3C of PRD #907, under the PRD #928
arch-lock). **No product implementation lands in this slice** — the output is
this doc plus the proposed implementation slices at the end, ready for
`/to-tickets`.

## Decision inputs (already settled)

- **Adoption path (human decision, 2026-07-02):** principles-only, re-implemented
  natively in **red-browser**. No external library is vendored; no source-repo
  names appear in code or docs (PRD #928 arch-lock). `/verify` and the frontend
  workflows consume red-browser as **clients**.
- **Output format:** every AI-facing surface emits **TOON**, per the repo-wide
  TOON mandate (ADR 0089, *AXI + TOON is the doctrine for every agent-facing
  CLI*). Human-facing stderr status lines (bridge URL, "audit passed") stay plain
  text.
- **Surface that exists today:** `apps/mcp-browser` ships a `snapshot` command
  (a11y tree + console + network over CDP) and an `annotate` command (HTML
  artifact bridge + layout-audit gate). Both currently emit `JSON.stringify(…, 2)`.

Because the hard decisions were made upstream (ADR 0089 sets the format doctrine;
PRD #928 sets the no-vendoring arch-lock; the HITL comment sets the adoption
path), **no new ADR is written here** — the three-condition test (hard to reverse
+ surprising without context + real trade-off) fails: this slice only *applies*
those decisions to one capability. See "ADR decision" below.

---

## 1. Inventory — where browser interaction happens today

### 1a. `/verify` — live-app verification loop

The `verify` skill drives a real app through the CDP driver and asserts against
ground-truth snapshots. Its browser interactions:

| Step | Operation today | Backed by |
|---|---|---|
| Launch a CDP Chrome and confirm targets | `google-chrome --remote-debugging-port` + `curl /json/list` | shell, not red-browser |
| Take a ground-truth snapshot | `red-browser snapshot --cdp … [--target …]` | red-browser (exists) |
| Assert element presence | read `a11y`, match `role` + `name` | agent parses JSON |
| Assert no console errors | read `console`, filter `level: "error"` | agent parses JSON |
| Assert a network call succeeded | read `network`, match URL + `status` | agent parses JSON |
| Stale-ref check across snapshots | manual rule — "is this `ref` still in the newest snapshot?" | agent discipline, **not enforced** |
| Interact, then re-snapshot | the skill *instructs* "re-snapshot after every interaction (form submit, navigation, state change)" | **no interaction command exists** |

**Two functional gaps surface immediately:**

1. **No interaction primitive.** `snapshot` is read-only. The skill tells the
   agent to interact and re-snapshot, but red-browser has no `click` / `type` /
   `navigate` / `wait`. Today the agent must reach for an out-of-band mechanism,
   which defeats the "one client surface" design.
2. **Stale-ref safety is advice, not a guarantee.** The rule lives in prose; the
   tool will happily let the agent reason about a `ref` from a superseded
   snapshot.

### 1b. Frontend workflows — artifact review loop

The `browser-review` skill (in-progress) plus its named entry points
(`/report-bug`, `/prototype`, `/impeccable`, `/verify`) share one loop:

| Step | Operation today | Backed by |
|---|---|---|
| Open an HTML artifact with an injected feedback SDK | `red-browser annotate <file>` / `openArtifact` | red-browser + `browser-bridge` (exists) |
| Block "done" on a broken render | layout-audit gate (`horizontal-overflow`, `clipped-text`, `text-overlap`) | red-browser (exists) |
| Poll surgical human annotations (selector + char range + comment) | bridge long-poll | `browser-bridge` (exists) |

This half is functionally complete; its only gap against the doctrine is **output
format** — `annotate` emits JSON, not TOON.

---

## 2. The four patterns — pain solved, or dropped

All four map to real pain in the flows above. **None dropped.**

### TOON output — **KEEP (highest token win)**
`snapshot` emits a pretty-printed JSON a11y tree — the single largest agent-facing
payload in the verify loop, re-emitted on every re-snapshot. Repeating every field
name on every node is exactly the waste TOON removes (one header row + bare data
rows). The repo-wide mandate requires it regardless; verify is where it pays off
most because the tree is big and read many times per task.

### Combined ops — **KEEP**
Two combinations matter:
- *Already combined (good):* `snapshot` returns a11y + console + network in one
  call, so an agent asserting "element visible AND no console errors AND API 200"
  spends one round-trip, not three.
- *Missing (add):* verify's core rhythm is **interact → re-snapshot**, which is
  two CLI invocations = two agent turns today. A combined **act-and-snapshot** op
  (`click <ref>` returns the resulting snapshot) collapses that to one turn. This
  is the combined-op pattern's real leverage here.

### a11y-tree snapshot with numbered refs — **KEEP (core, partly built)**
`snapshot` already tags each node with a stable integer `ref`. Refs are the
addressing scheme the interaction ops target ("click ref 7") and the anchor
stale-ref validation checks. This is the spine of the whole design and is the one
pattern already partly implemented.

### Stale-ref validation — **KEEP (correctness guarantee, currently unenforced)**
Move the rule out of prose and into the tool: every `ref` is minted by a specific
`snapshotId`; an interaction op that targets a `ref` from a superseded snapshot
returns a typed `stale-ref` result in TOON **instead of acting on a moved/absent
node or letting the agent hallucinate**. This converts "the agent must remember to
re-check" into "the tool refuses the unsafe action." It is the anti-hallucination
contract, enforced.

---

## 3. Scope — red-browser capabilities consumed by `/verify`

red-browser stays the single browser client surface. `/verify` and the frontend
skills are **clients** — they shell out to red-browser and read TOON; they never
open CDP or a bridge themselves.

| Capability | Status | Shape |
|---|---|---|
| `snapshot` | exists → **retarget output to TOON** | a11y + console + network combined; each node carries `ref` + the minting `snapshotId` |
| **interaction ops** | **new** | `click <ref>`, `type <ref> <text>`, `navigate <url>`, `wait <condition>` — each validates the target `ref`, performs the action, and returns the **resulting snapshot** (combined act-and-snapshot), all in TOON |
| **stale-ref validation** | **new (cross-cutting)** | a `ref` from a superseded `snapshotId` yields a typed `stale-ref` TOON result, never a silent mis-click |
| `annotate` | exists → **retarget output to TOON** | unchanged behavior; JSON → TOON |

**Shared TOON encoder.** TOON serialization lives in the shared
`@reddb-io/toon` package. red-browser should import that package directly so it
does not fork its own encoder and drift from the dev surfaces.

**Boundaries / non-goals.**
- No screenshot/pixel diffing — a11y tree + layout-audit is the ground truth.
- No headless orchestration or Chrome lifecycle management inside red-browser;
  the skill still launches Chrome (documented flags stay in the SKILL).
- No decoder — TOON is emit-only, exactly as the existing encoder is.

---

## 4. Proposed implementation slices (for `/to-tickets`)

Tracer-bullet vertical slices, each independently grabbable, ordered so each
unblocks the next. Parent: #907 / arch-lock #928.

1. **Use the shared TOON package.** Import `@reddb-io/toon` in both `dev` and
   `red-browser` output paths. *Mechanical, unblocks every output slice.*
2. **`snapshot` emits TOON.** Convert the `snapshot` command output from JSON to
   TOON using the shared encoder. Update the `/verify` SKILL.md "Output schema"
   and assertion examples from JSON to TOON. *Biggest token win, small blast
   radius.*
3. **Stale-ref validation primitive.** Refs carry their minting `snapshotId`; add
   a validation helper that returns a typed `stale-ref` TOON result for a ref from
   a superseded snapshot. Foundation for the interaction ops. Tests: fresh ref
   resolves, superseded ref rejects.
4. **Interaction ops (combined act-and-snapshot).** Add `click` / `type` /
   `navigate` / `wait`; each validates the target ref (slice 3), performs the
   action via the CDP driver, and returns the post-action snapshot in TOON.
5. **Wire `/verify` to the interaction ops.** Update the `verify` SKILL.md loop to
   use the new ops (remove the "no interaction command / reach out-of-band"
   workaround) and the enforced stale-ref result. Skill-only slice.
6. **`annotate` emits TOON + graduate `browser-review`.** Convert `annotate`
   output to TOON; move `browser-review` out of `in-progress/` and confirm the
   `/report-bug`, `/prototype`, `/impeccable`, `/verify` entry points reference the
   red-browser surface. Register per repo Rule 1 (README + plugin manifests).

## ADR decision

**No ADR written.** Three-condition test: **hard to reverse?** No — output format
and command surface are already fixed by ADR 0089 and PRD #928; these slices apply
them. **Surprising without context?** No — TOON everywhere and no-vendoring are the
documented defaults. **Real trade-off?** No live alternative — the adoption path is
a settled human decision. The relevant records already exist (ADR 0089 for the TOON
doctrine, PRD #928 for the arch-lock, this doc for the capability scope).
