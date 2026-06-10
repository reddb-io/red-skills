# Backpressure Gate

`afk.backpressure` is an ordered list of shell commands that supplements (not replaces) the auto-derived feedback gate. On DONE, after the scope-derived `test`/`typecheck`/`lint`/`build` feedback passes, each command runs in order. If any exits non-zero the merge is blocked (`blocked:validation`), the command and output tail land in the terminal envelope and validation sidecar, and the issue is parked to `ready-for-human`.
