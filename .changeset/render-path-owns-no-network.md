---
"@reddb-io/dev": patch
---

Remove every network call from the statusline render path and stop a full event lane from paying a whole compaction per event.

The statusline now performs one local socket read and never runs a project collector, tracker client, or CI-log client — the cold path included. A command another package imports runs nothing on import: the daemon's statusline command moved out of the CLI entry module, whose self-invocation guard is always true inside a single-file bundle and was shipping a second argv-reading CLI inside every dev binary.

The host event lane at its cap no longer rewrites its full contents on every appended event; the bound, boot-replay ceiling, and rebaseline contract are unchanged.
