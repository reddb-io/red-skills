---
"@reddb-io/redskilled": patch
---

An error that crosses the ACP wire keeps its words: a handler that threw a
plain Error reached the Worker as bare "Internal error" with the message
swallowed, so every carefully-worded refusal in the publish path died on the
wire. The method registry now re-throws non-RequestError exceptions as a
RequestError carrying the original sentence.
