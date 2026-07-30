---
"@reddb-io/red-skills": patch
---

The `memory` binaries parse their arguments through the one shared argument contract (#2874). Routing was a switch over a token the CLI peeled off itself, and the version answer was a bespoke branch that fired on `--version`, `-v`, a `version` command, or a version flag appearing **anywhere** in argv — so `memory recall "topic" --version` printed a version string instead of recalling. Every hand-rolled parser answers the questions a parser must answer in its own way, and this one answered "whose flag is this?" wrongly.

**Routing is `routeCommand`'s now and the binary's own flags are `parseFlags`'.** A named command owns every flag that follows it; `--version`, `-v` (with `--json`) and `--help`, `-h` are the binary's, answered when no command was named. Both are answered before config, enablement, or any store — the version of a build is asked for exactly in the directory that never ran `memory init`, and it holds up there. `memory-mcp` answers the same way, before the store opens or stdio is claimed.

A typo'd command and an unknown flag now each fail naming what was typed and which kind of thing it was, instead of every unrecognised leading token being reported as an unknown command with the full manual dumped after it. Two dead argv scanners — one in `recall`, one in `docs`, each with its own rules for what a flag is and when a value follows one — are gone; a test refuses the next one to appear in the CLI tree.
