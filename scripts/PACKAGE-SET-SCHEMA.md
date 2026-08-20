# `red.package-set` — the signed workstation set manifest

A RedSkills release attaches one manifest that names every artifact a
workstation installs, correlated to one source commit and authenticated by one
Sigstore signature. This file is the schema consumers mirror. It lives beside
`verify-package-set.mjs` because a consumer that has the verifier has this, and
a consumer that guesses writes a second, subtly different verifier.

## `red.package-set.v2` (current)

```json
{
  "schema": "red.package-set.v2",
  "sourceCommit": "<40 lowercase hex>",
  "version": "4.0.0",
  "channel": "stable",
  "targets": ["linux-x64", "windows-x64"],
  "artifacts": [
    { "name": "<one local basename>", "sourceCommit": "<40 hex>", "size": 123, "sha256": "<64 hex>" }
  ],
  "wholeSetDigest": "<64 hex>"
}
```

**Key order is part of the contract.** The verifier compares the manifest's key
list against the expected list exactly, in both the manifest and each artifact
entry, and re-encodes the bytes to check they are canonical
(`JSON.stringify(manifest, null, 2)` plus a trailing newline). Reordering keys
is a different manifest, not a formatting choice.

**`wholeSetDigest` covers the identity, which is every key except itself** — in
order: `schema`, `sourceCommit`, `version`, `channel`, `targets`, `artifacts`.
The digest is `sha256` over `JSON.stringify(identity) + "\n"`.

| Field | Meaning |
| --- | --- |
| `schema` | The schema name. A reader must refuse an unknown one rather than read the fields it recognises. |
| `sourceCommit` | The one commit every artifact was built from. Each artifact restates it, and a mismatch is refused. |
| `version` | The release version. |
| `channel` | One of `stable`, `canary`, `next`, `pinned` — a closed set, so a reader can decide on it. |
| `targets` | Sorted, unique platform tokens from `linux-x64`, `windows-x64`. A target-specific depot refuses a set built for another platform. |
| `artifacts` | Sorted unique basenames with size and `sha256`; names are local basenames, never paths. |
| `wholeSetDigest` | `sha256` of the identity bytes above. |

Verify with the copy of the verifier that ships in the set:

```bash
node verify-package-set.mjs \
  --manifest package-set.manifest.json \
  --bundle package-set.manifest.sigstore.json \
  --require-target linux-x64
```

`--require-target` is how a depot refuses a set built for another platform;
without it the verifier checks everything else and reports the declared targets
on its success line.

## Which file carries which schema

While readers migrate, a Release attaches **both**:

| File | Schema | Who reads it |
| --- | --- | --- |
| `package-set.manifest.json` | v1 | every existing verifier, including red-dev's mirror |
| `package-set.manifest.v2.json` | v2 | readers that need version, channel or targets |

Each has its own Sigstore bundle (`…sigstore.json` beside it), and both are
built from one pass over the same artifacts, so they cannot describe different
sets. **The canonical name flips to v2 when the readers have flipped, and v1
leaves then — not before.** v2 taking that name in 4.0.0 is what made red-dev
refuse every set from that release with `manifest shape or key order is not
canonical`, and a machine that cannot install the release cannot be told about
the release.

The shipped `verify-package-set.mjs` verifies either one. `--require-target`
needs v2 and says so against a v1 manifest rather than reading a field that is
absent.

## `red.package-set.v1` (still canonical during the transition)

v1 carries `schema`, `sourceCommit`, `artifacts`, `wholeSetDigest` and nothing
else. **Adding a key could not be a compatible change**: the canonical key-set
check makes any addition a different shape, and a key outside the identity would
sit outside the signature — which is exactly the flaw v2 repairs. `version`,
`channel` and `targets` were read from around the manifest (a `package.json` in
the expanded tree, an out-of-band assumption) rather than from the bytes
somebody signed. A v1 reader fails closed on a v2 manifest, which is the
intended migration: refuse, then upgrade.
