---
"@reddb-io/protocol-acp": patch
"@reddb-io/shared": patch
"@reddb-io/worker": patch
---

The execution doors check brief structure, not wording

The machine-checkable judgement, enforced at the handoff decoder and the
Worker preflight, refused 41 of 42 live briefs across both registered
projects, so every drain tick became a birth-and-refuse loop. The judgement
moves to triage promotion, where the author is present to fix the sentence;
the decoder and the preflight now refuse only a brief with no
acceptance-criteria section or an itemless one, via
`briefContractStructuralRefusal` in `@reddb-io/shared/brief-contract`.
