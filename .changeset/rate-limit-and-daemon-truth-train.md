---
"@reddb-io/redskilled": minor
"@reddb-io/dev": minor
"@reddb-io/red-skills": minor
"@reddb-io/rsp": minor
---

Rate-limit resilience and daemon truthfulness train.

GitHub budget — the fixes for the GraphQL-exhaustion incident:

- The quota wait stops hammering: the fallback backoff doubles per retry up to a 10-minute ceiling instead of retrying every 60 s (8,994 fixed-interval retries were measured in one evening), with an injectable reset probe seam (#3663).
- The engine's landing pipeline rides REST rails where a REST equivalent exists, keeping the GraphQL pool for the operations that need it.

Daemon truthfulness — a Worker is only dead when the host says so:

- Boot censuses active systemd units before attributing deaths, ending the mass false "ended while no daemon was watching" verdicts for Workers that were alive the whole time (#3578).
- Unit-path teardown confirms death instead of assuming it (#3642); a failed orphan reap no longer leaves a phantom birth (#3643); the demand formula counts busy Workers correctly (#3579); registration recovery is deterministic across boots (#3656).
- The host event lane reader survives one historical malformed row instead of wedging the whole lane (#3651), and lane writes gain durability for attributions (#3646).

Engine and surfaces:

- The suspect-infra classifier stops calling branch faults infrastructure: repeated signatures with changed pinned behavior and fast exits carrying real diagnostics are branch verdicts now (#3648).
- The janitor's worker-prune races with concurrent births are closed (#3650), and the promised 256 MiB live-log warning actually fires (#3644).
- castle emits canonical TOON via the current encoder — no more hand-written non-canonical rows (#3662); rsp migrates to @reddb-io/toon 0.21 (#3624).
- The statusline line reshape lands compact bedrock counters (#3606), and the interview-rounds convention is extracted to a shared reference consumed by start/wayfinder/reflect/hitl/to-spec (#3669).
