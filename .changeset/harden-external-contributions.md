---
"@reddb-io/dev": patch
---

Harden the repo and AFK flow against untrusted external contributions (#2603):

- New `CONTRIBUTING.md` documents the spec-first policy (ideas as issues;
  unsolicited feature PRs closed by policy), the diff-only fork-review posture,
  and the audited GitHub Actions fork posture.
- The `red-issues-needs-triage` workflow now marks external-author issues **and**
  PRs with an auto-created `origin:external` label, resolving author write access
  via the collaborators permission API (fail-safe: undeterminable → external).
- The `/afk` claim path refuses to execute an `origin:external` issue — parking
  it `ready-for-human` — until a maintainer posts `/approve-external`, verified
  through the existing write-access trust resolver. Integrated into
  `evaluateClaimTrust`; an approval also vouches for the external author on the
  fail-closed path while still requiring a maintainer promoter.
- `/triage` docs and `triage-labels.md` treat external-origin bodies as
  untrusted data and document the new label + gate.
