---
"@reddb-io/red-skills": patch
---

The statusline draws late data instead of drawing nothing, and says why in plain words

A read the daemon answered was thrown away whenever the lifecycle verdict was
not `live`, and one token printed in its place. So an operator asking "how is
the queue" got `rsk=degraded` — a report about the reporter, in exchange for
every number they wanted. Late numbers are worth more than no numbers.

Data now always wins. A tail that exists is rendered whatever the state, with a
LEADING badge: the age when lateness is the message (`age=4m · 0w idle rdy=0
…`), the situation otherwise (`rsk=no-producer · …`). The badge leads rather
than trails so the age is read BEFORE the values it qualifies rather than
discovered after them. A bare state token is what remains only when there is
genuinely nothing to draw.

The state names now describe the situation rather than the mechanism, because
they are read in a prompt by someone doing something else: `bedrock-only` →
`no-daemon`, `registering` → `joining`, `unregistered` → `no-producer`,
`degraded` → `stale`. `connecting` and `live` are unchanged, and `live` still
renders no badge — health is its own evidence.
