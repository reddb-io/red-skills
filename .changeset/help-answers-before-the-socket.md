---
"@reddb-io/red-skills": patch
---

`redskilled --help` now prints the subcommand list instead of reaching for the socket first (#2918). Asking for usage routed to the default `host-state` command, so the answer to "what are the commands?" was "the daemon is unreachable, so no Worker was started" — a question about the interface, answered by the outage it was being asked about. `--help`, `-h` and `help` are answered ahead of routing, and `<command> --help` is answered ahead of dispatch, so no help path can open a socket, start a daemon or read config.

**The invariant that already guards `--version` now covers `--help`, so a new binary inherits both.** The shipped-binary ratchet (#2878) held that a version answer must come off the build stamp *because `--version` is asked precisely when config, stores and sockets are broken*. Help is asked under the same conditions and usually by someone already lost, so the same reasoning applies: a binary must route `--help` to a usage constant on its STATIC front-door path — its entry, or the one module it hands its command surface to — and must not touch a socket, config, a store or the filesystem on the way there. The touches are named one by one rather than lumped as "side effects", because the list is the claim.

**Three more shipped binaries answered usage with a refusal, and now answer it with usage.** `red-skills-castle-mcp --help` fell into the unroutable-subcommand error, so the command that says which subcommands exist replied by rejecting an unknown one; `brain-mcp` and `memory-mcp` routed only `serve` and `version`. Usage reachable only from a lazily-loaded subcommand module does not count — that shape is exactly how castle-mcp read as green while answering an operator with an error.

**Every failure mode is proved with a fixture, not only the passing state**: a route that never fires, usage printed after the socket is opened, a route with no usage beside it, usage buried in a lazily-loaded module, and a `{` inside usage text that must not be mistaken for a scope. `redskilled --help` is additionally proved to reach *nothing* in the client module, against a runtime directory with no socket in it.
