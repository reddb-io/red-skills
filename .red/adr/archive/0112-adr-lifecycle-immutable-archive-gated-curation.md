# 0112 — ADR lifecycle: immutable records, physical archive, and gated curation

## Status

Accepted. Records the design settled in a `/start` grilling session for evolving
`/review-adrs` from a read-only detector into a full ADR-lifecycle skill. The
finer parameter choices are carried in the originating Spec's Human Decisions.

## Context

ADRs accumulate (110+) and drift: decisions get superseded but never marked,
prose cites paths that have since moved, some decisions shipped long ago and are
now inert, others overlap or should be split. The existing `/review-adrs` is a
read-only detector that emits one Spec and never applies — it has no per-ADR
triage, no archive, no merge/split, and no history-preservation guard. Left
unmaintained, the active `.red/adr/` set becomes a cluttered mix of live
guidance and dead records, and the governance test (`adr-governance.test.ts`,
which enforces a bijection between filename numbers and INDEX bullets) predates
any archive concept. The maintainer's explicit fear: fixing this must not ruin
the decision history.

## Decision

- **ADRs are immutable-hybrid records.** The original Decision is never
  rewritten; only status, `Related` / `superseded-by` links, and stale-path
  prose are edited in place. To "update" a decision, mint a new ADR that
  supersedes the old one.
- **Archiving is physical.** A terminal ADR — superseded, deprecated, or fully
  shipped and inert — is `git mv`'d to `.red/adr/archive/` (history preserved;
  `git log --follow`). The active `.red/adr/` holds live guidance; `archive/`
  holds retired records.
- **Merge and split are supersede-and-replace, never in-place rewrites.** Merge
  mints one consolidating ADR and archives the N originals (each
  `superseded-by` the new one). Split mints N focused ADRs and archives the
  original (`superseded-by` the list). The number set grows — the honest cost of
  an immutable record.
- **One skill, gated-split apply.** `/review-adrs` evolves in place (one entry
  point). It runs a cheap **hybrid triage** over every ADR — or over an optional
  **subject filter** — bucketing by status / age / inbound links / stale refs /
  supersession, then deep-reviews only the flagged buckets. Mechanical,
  reversible operations (git mv to archive, status frontmatter, INDEX resync,
  stale-path prose fixes) apply **in-session behind a confirmation gate**;
  judgment operations (merge, split, supersede a live decision, "this decision is
  incoherent") go through the one-question interview → a Spec → `/afk`. The
  read-only detection remains the default posture.
- **History preservation is machine-enforced.** The governance test evolves so
  "archived" is first-class: the bijection becomes
  `Set(active ∪ archived numbers) === Set(INDEX numbers)`, every archived number
  stays documented in the INDEX (its own section), and CI fails if any ADR
  number disappears, an archived/superseded ADR lacks a successor pointer, or an
  archived file is removed (`archive/` is append-only).

## Considered options

- **Living documents** (rewrite / merge / split files in place): rejected — it
  rewrites the historical record, the exact failure being guarded against.
- **Status-only archive** (no physical move): rejected — it never declutters the
  active set, which is the stated pain.
- **Propose-only apply** (today's path, everything → Spec): rejected as the sole
  route — deferring mechanical cleanup to a Spec is too indirect; the gated
  in-session apply cures that while judgment ops stay behind the interview.
- **Convention-only history preservation**: rejected — by-construction safety is
  only as strong as the next careless edit; a CI guard is the real armor.
- **A separate curation skill**: rejected in favor of evolving `/review-adrs` in
  place — one door for the ADR surface.

## Consequences

- The active `.red/adr/` stays lean and legible; retired records live in
  `archive/`, still discoverable and INDEX-documented.
- Lifecycle operations mint new ADR numbers (merge / split / update-as-supersede).
- The governance test must be updated in lockstep with the archive introduction,
  or CI reddens.
- `/review-adrs`'s current "never applies" hard rule is replaced by the
  gated-split; read-only detection stays the default.
