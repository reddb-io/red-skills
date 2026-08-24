---
"@reddb-io/redskilled": patch
---

A daemon error on a request it did parse now echoes that request's id (or answers `id: null` when it carried none) instead of minting a fresh one — a fresh id is reserved as the dialect-downgrade proof for frames that were never parsed, so an ordinary handler failure can no longer silently downgrade a healthy TOON client to JSON.
