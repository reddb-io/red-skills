# Design — HTML-artifact review surface (`browser-bridge` × `/review`)

Design/scoping output for issue #993 (Track 3D of PRD #907, under the PRD #928
arch-lock). **No product implementation lands in this slice** — the output is
this doc plus the proposed implementation slices at the end, ready for
`/to-tickets`.

This is the **review-surface half** (the "lavish-half"). Per the human decision
it is scoped and sequenced **before** the browser-automation half (#992, whose
scope lives in `apps/red-browser/DESIGN.md`).

## Decision inputs (already settled)

- **Adoption path (human decision, 2026-07-02):** **extend `/review`** — one
  review verb, no new review skill (vocabulary hygiene). The annotate +
  poll-for-feedback + layout-audit loop is implemented natively as
  **`browser-bridge`** capabilities on the red-browser stack; `/review` consumes
  them as a client. No vendoring; no source-repo names in code or docs (PRD #928
  arch-lock).
- **`red-ui` is out of scope as owner.** It stays the memory/brain graph viewer;
  a future read-only consumer at most, never the review surface.
- **Ordering:** this review-surface half is built **before** #992's automation
  slices (lavish-half first).
- **Output format:** every AI-facing surface emits **TOON**, per the repo-wide
  mandate (ADR 0089, *AXI + TOON is the doctrine for every agent-facing CLI*).
  Human-facing stderr status lines (bridge URL, "audit passed") stay plain text.

## Ground-truth correction

The issue brief describes browser-bridge as "an empty shell." **That is stale.**
The package is functionally complete today:

| Piece | State |
|---|---|
| `session.ts` — filesystem session store, `openArtifact` / `recordAnnotation` / `pollAnnotations` / `resolveAnnotation` | built |
| `server.ts` — `node:http` long-poll transport, `dispatchBridgeRequest` (pure mapper) | built |
| `open-bridge.ts` — `openBridge(html)` → `{ url, layoutAudit(), waitForAnnotation(), close() }` | built |
| `inject.ts` — additive, self-guarding, byte-reversible SDK injection | built + tested |
| `annotation-sdk.ts` / `layout-audit-sdk.ts` — browser-side probes | built |
| `layout-audit.ts` — `auditLayout` / `assertLayoutClean` (`horizontal-overflow`, `clipped-text`, `text-overlap`) | built + tested |
| `apps/red-browser` `annotate` CLI command | built |
| `/review` skill (`plugins/dev/skills/engineering/review`) consuming `annotate` | shipped |

So the review-surface half is **~90 % built**. This slice therefore scopes the
*remaining* work, not a green-field build: (a) close the loop gaps in the
consumed surface, (b) convert output to TOON, (c) define the `/review` ↔
browser-bridge contract crisply, (d) consolidate the duplicate skill so there is
one review verb.

---

## 1. Where the review-surface pattern adds value beyond `/review` + `red-ui`

Claims are kept only where they name pain **not already covered**. Two are
dropped as already-covered; three are kept.

### Dropped — already covered

- **"Surgical element annotation replaces screenshot + prose."** Already the core
  of the shipped `/review` skill (element `xpath` + `charRange`). Nothing to add.
- **"A layout-audit gate blocks *done* on a broken render."** Already shipped
  (`assertLayoutClean`; CLI exits code 2 on violations). Nothing to add.

### Dropped — `red-ui` overlap claim

- **"`red-ui` could host the review surface."** Dropped. `red-ui` renders the
  **memory/brain graph** from a fixed data source (memory plugin `view` skills);
  it is not a viewer for arbitrary agent-generated HTML artifacts (plans,
  dashboards, prototypes), has no injection/annotation/layout-audit path, and the
  human decision removes it as owner. No real overlap exists to reconcile.

### Kept — genuine gaps the pattern closes

1. **Continuous multi-annotation session.** The shipped `annotate` CLI waits for
   **one** annotation, prints it, and exits (`waitForAnnotation` → single result).
   A real review is a *loop*: the human posts several surgical notes, the agent
   fixes each, the human keeps going until satisfied. The store already supports
   it (`pollAnnotations` with a cursor; `resolveAnnotation`), but the consumed CLI
   surface does not expose the loop. **Value: turn the single-shot into the
   human-paced poll loop the skill already promises.**
2. **Acknowledgement / resolve visibility.** `resolveAnnotation` marks a note
   acted-on, but nothing surfaces that back — the human cannot see which of their
   annotations the agent has addressed. **Value: close the feedback triangle so
   the human paces against real progress, not guesswork.**
3. **TOON output.** `annotate` emits `JSON.stringify(…, 2)`. Each annotation
   repeats every field name; a multi-note session re-emits the schema on every
   poll. TOON emits one header row and bare data rows. **Value: the token win the
   mandate requires, biggest across a many-annotation session.**

---

## 2. The annotate → poll-for-feedback → layout-audit-gate loop

Expressed as `browser-bridge` capabilities, with how the `/review` loop consumes
each step. `/review` is a **client**: it shells out to `red-browser` and reads
TOON; it never opens the bridge server or touches the store directly.

| # | Loop step | browser-bridge capability | `/review` consumes it as |
|---|---|---|---|
| 1 | **Open** the artifact | `openArtifact(html)` writes `<file>.bridge.html` + session state; `openBridge` starts the long-poll server and prints the URL to **stderr** | `red-browser review <file>` → agent tells the human to open the printed URL |
| 2 | **Gate** on load | `assertLayoutClean(snapshot)` runs on first render; violations (`horizontal-overflow`, `clipped-text`, `text-overlap`) → exit code 2 + TOON violation table on stdout | if exit 2: agent fixes violations, regenerates, re-runs — **never declares done** |
| 3 | **Poll** for feedback | `pollAnnotations(root, id, cursor)` long-polls; each hit → a TOON annotation row (selector + xpath + charRange + comment + id) on stdout, advancing the cursor | agent parses the TOON row, treats the element + char range as the surgical spec, applies exactly that correction |
| 4 | **Resolve / ack** | `resolveAnnotation(root, id, annId)` marks the note acted-on; the ack is echoed back to the browser SDK | after each fix the agent resolves the note; the human sees which annotations are addressed and keeps pacing |
| 5 | **Iterate** | loop back to step 2 (re-gate the new render) then step 3 (next annotation) until the human stops or declares done | one annotation per iteration; the human controls the pace; done requires a clean gate **and** no open annotations |

The single new behaviour versus today is that steps 3–5 form a **continuous
loop** (cursor-advanced poll + resolve) rather than one-shot `waitForAnnotation`.
Every other capability already exists.

---

## 3. Contract between `/review` and `browser-bridge` — all TOON

`/review` reads exactly three stdout payload kinds from `red-browser review`.
Every one is **TOON** (emit-only, deterministic encoder). Human-facing status
(bridge URL, "layout audit passed") stays plain-text stderr — never mixed into
the machine-read stdout stream.

**Encoder is shared, not forked.** TOON serialization lives in the shared
`@reddb-io/toon` package. `browser-bridge` must consume that package so the two
surfaces never drift into two encoders.

### 3a. Layout-audit result (step 2)

Emitted on load; a non-empty violation set is the exit-code-2 stop signal.

```toon
audit: pass=false
violations[2]{kind,selector,detail}:
  horizontal-overflow,#plan > section:nth-of-type(2),scrollWidth 812 > clientWidth 375
  text-overlap,#summary,overlaps #sidebar by 240px^2
```

On a clean render: `audit: pass=true` with an empty `violations[0]{…}` table.

### 3b. Annotation poll result (steps 3–5)

Each poll returns the cursor plus zero or more annotations. The element carries
both a human-readable id (`tag`/`id`) and the exact `xpath`; the char range is
the surgical span.

```toon
poll: cursor=3
annotations[1]{id,selector,xpath,charStart,charEnd,quote,comment,status}:
  a7,#summary,/html/body/section[1]/p[@id='summary'],12,28,the second phase,"tighten this line",open
```

An empty poll (timeout, no new note) → `poll: cursor=3` + `annotations[0]{…}`.

### 3c. Resolve acknowledgement (step 4)

```toon
resolve: id=a7 status=resolved
```

**Contract invariants.**
- stdout is TOON only; stderr is human status only. `/review` reads stdout.
- The client never opens CDP or the bridge server itself — one client surface.
- No decoder ships — TOON is emit-only, matching the existing encoder.
- Every `xpath`/`selector`/`charRange` is echoed verbatim from the browser SDK;
  the agent must not widen the correction scope beyond the annotated span without
  explicit human agreement (already a `/review` hard rule).

---

## 4. Proposed implementation slices (for `/to-tickets`)

Tracer-bullet vertical slices, each independently grabbable, **sequenced before
#992's automation slices** (lavish-half first). Parent: #907 / arch-lock #928.
Slice 1 is the shared prerequisite #992 also depends on — landing it here (first)
satisfies the ordering constraint and unblocks both halves.

1. **Use the shared TOON package.** Import `@reddb-io/toon` in both `dev` and
   `red-browser`/`browser-bridge` output paths so every surface shares one
   encoder/decoder authority. *Mechanical; unblocks every output slice in both
   halves.*
2. **Continuous review loop in the consumed surface.** Add a `red-browser review`
   command (or extend `annotate`) that, after a clean gate, **long-polls in a
   loop** — emitting one TOON annotation payload per note and advancing the
   cursor — instead of `waitForAnnotation`'s single-shot exit. Expose
   `resolveAnnotation` so the agent can ack each note. Tests: two sequential
   annotations both surface; cursor advances; resolve marks status.
3. **Review surface emits TOON.** Convert the layout-audit result (3a), the poll
   result (3b), and the resolve ack (3c) from JSON to TOON via the shared encoder.
   Human status stays stderr plain-text. Tests: golden TOON for each payload kind;
   stderr stays plain.
4. **Wire `/review` to the loop + TOON contract, consolidate to one review verb.**
   Update `plugins/dev/skills/engineering/review/SKILL.md` to consume the
   continuous loop and parse the TOON payloads (3a–3c). **Fold the in-progress
   `browser-review` skill into `/review` and remove it** — one review verb per the
   human decision; do not graduate a second review skill. Re-point the
   `browser-review` entry points (`/report-bug`, `/prototype`, `/impeccable`,
   `/verify`) at `/review`. Register per repo Rule 1 (README + plugin manifests);
   say in the commit what was removed and why.

> **Corrects #992's plan.** `apps/red-browser/DESIGN.md` slice 6 proposes
> *"graduate `browser-review`"* as a separate skill and pushes `annotate → TOON`
> to the end. The #993 human decision overrides both: there is **one review
> verb** (`/review`), so `browser-review` is consolidated and removed (slice 4
> here), and the review surface's TOON conversion (slice 3 here) lands **before**
> #992's automation slices, not after. When #992 is re-sliced, its slice 6 drops.

---

## ADR decision

**No ADR written.** Three-condition test:

- **Hard to reverse?** No — the output format and the client/one-verb shape are
  already fixed by ADR 0089 (TOON) and the settled human decision; these slices
  apply them.
- **Surprising without context?** No — TOON everywhere, one review verb, and
  no-vendoring are the documented defaults (ADR 0082, PRD #928).
- **Real trade-off?** No live alternative — the adoption path (extend `/review`,
  native browser-bridge, red-ui out) is a settled human decision, not an open
  design choice.

The relevant records already exist: ADR 0089 for the TOON doctrine, PRD #928 for
the arch-lock, this doc for the review-surface scope.
