---
"@reddb-io/red-skills": patch
---

The `brain` binaries parse their arguments through the one shared argument contract (#2877). Routing was a `switch` over a token the CLI peeled off `process.argv` itself, every command's flags came from a private argv walk that only recognised `--long` spellings, and the binary exposed no version surface at all — `brain --version` was reported as an unknown command.

**Routing is `routeCommand`'s now and every command's flags are `parseFlags`'.** `brain` accepts `--version`, `-v` (with `--json` for the structured build info) and `--help`, `-h`, answered before config, enablement, or any store or socket — the version of a build is asked for exactly in the directory that never ran `brain init`, and it holds up there. `brain-mcp` answers the same way, before the store opens or stdio is claimed.

Each command's accepted flags are now stated as a schema rather than inferred from whatever the walk happened to read, so `-h`, `--limit=3`, and `--limit 3` all work, `--limit many` fails naming the flag instead of silently becoming `NaN`, and a flag no command declared fails naming it rather than being swallowed as a default the caller believed they had overridden. A typo'd command is reported as a command and an undeclared flag as a flag, instead of both arriving as "unknown brain command". A test refuses the next hand-rolled argv walk to appear in the CLI entry.
