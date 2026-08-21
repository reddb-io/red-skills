---
"@reddb-io/redskilled": patch
"@reddb-io/protocol-acp": patch
"@reddb-io/worker": patch
"@reddb-io/red-skills-dev": patch
---

Every catalog Agent declares its unattended posture, and opencode gets its own DB

Admission is generic, but only two of the five Agents could actually finish a
turn: claude-code and pi had no unattended posture declared at all, and opencode
had neither a posture nor per-Worker DB isolation despite using `opencode.db` —
the exact file redcode#58 is about.

`unattendedPosture` is now a REQUIRED descriptor field, so a sixth Agent cannot
land unpostured, and the conformance matrix pins the table against the catalog
in both directions. The postures were probed, not guessed: claude-code-acp
parses no argv at all, so its posture is the ACP session mode `bypassPermissions`
(observed live: two refused permission requests and a dead turn on defaults;
zero requests, `end_turn` and the file written with the mode set), which now
travels on the endpoint and is applied by the Worker right after `session/new`.
pi-acp accepts exactly one argument, `--terminal-login`, and never routes a tool
call through a permission request, so it is `none-needed` with that reason.
opencode and redcode share one permission engine and now share one DB-isolation
branch, each Worker's child getting its own database in its disposable workspace.
