---
"@reddb-io/red-skills": patch
---

Local vector maintenance writes its index once per pass, not once per vector

`memory vector maintain --local` rewrote the aggregate local-vector index after
**every** record. The index names every projected vector, so a pass over N
vectors wrote O(N²) bytes into a store that keeps every version: #3970 measured
2233 vectors turning a 186 KB store into 3.75 GB while `memory doctor` reported
healthy at every step — because nothing was corrupt, only amplified.

A maintenance pass now holds the index open and flushes it exactly once, in a
`finally` so a pass that dies under `--strict` still records the vectors it did
project (an index that forgot them is worse than a large one: recall would not
find records that are physically there). A single projection outside a pass
still writes through, so nothing that projects one vector loses its entry.

The remaining footprint is RedDB's physical version retention, which this
repository does not own; the amplification it was multiplying is gone.
