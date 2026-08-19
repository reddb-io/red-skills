---
"@reddb-io/red-skills": minor
---

`red.package-set.v2`: version, channel and targets ride inside the signature

A consumer verifies the published set before it moves a machine, and the three
facts it has to decide on — which version, which channel, which platform the
set was built for — sat OUTSIDE the bytes anybody signed: the version came from
a `package.json` in the expanded tree, the channel and target from assumption.
**A fact a consumer decides on belongs inside the signed identity.**

`version`, `channel` (a closed set: `stable`, `canary`, `next`, `pinned`) and
sorted `targets` now sit in the identity the whole-set digest and the Sigstore
signature cover. Adding a key could never be compatible — the canonical key-set
check makes any addition a different shape — so this is a schema bump, and a v1
reader fails closed on a v2 manifest by design.

The release passes its own version, `stable`, and the targets the one payload
enumeration declares (`workstation-package-set.mjs --targets`), never a literal
written in the workflow. `verify-package-set.mjs` gains `--require-target`, so
a target-specific depot can refuse a set built for another platform instead of
having only an unknown schema to gate on. The schema is written down beside the
verifier that ships in the set (`scripts/PACKAGE-SET-SCHEMA.md`), because a
consumer that has to mirror it otherwise guesses.

Closes #4005.
