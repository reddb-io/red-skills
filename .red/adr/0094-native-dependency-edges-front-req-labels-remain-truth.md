# Native dependency edges are the human surface; req:N labels remain the runtime's source of truth

Upstream v1.1.0 (`to-tickets`, `wayfinder`) prefers GitHub's native sub-issues and blocked-by relationships over body-text conventions, because the tracker renders the dependency frontier visually. Our AFK runtime, however, resolves dependencies from `req:N` edge labels + `blocked:dependency` (close cascade, boot unblock sweep, gate census) — proven code with a history of subtle race fixes.

We adopt a hybrid: publishing skills (`/to-tickets`, `/wayfinder`, `/triage`) write the **native** sub-issue and blocked-by relationships *in addition to* the `req:N` labels; the runtime keeps reading **only** the labels. Humans get the native UI, the machine keeps the proven mechanism. The controlled redundancy is deliberate, not accidental — do not "clean up" one side.

## Considered Options

- **Full native** (runtime queries GitHub's dependency API, labels die) — rejected for now: rewriting the close cascade / boot sweep trades proven machinery for API surface we haven't validated under our race conditions. Revisit as a future contract once the native API proves queryable at equal cost; this ADR can then be superseded without reopening the vocabulary rename (ADR 0093).
- **Reject native edges** — rejected: the visual frontier and sub-issue tree are real collaboration wins at near-zero risk.

## Consequences

- Divergence is possible (native edge without label or vice versa); the writer skills own writing both, and `/doctor` gains a consistency check.
- The `## Blocked by` body section remains as the fallback for trackers/paths where native edges are unavailable, unchanged.
