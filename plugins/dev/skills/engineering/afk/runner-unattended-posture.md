# Runner: the unattended posture of every Agent

What makes each catalog Agent able to WORK with nobody at the keyboard, and the
evidence behind each answer. The declaration lives in
`apps/redskilled/src/acp-unattended-posture.ts`; this is the operator's copy.

## Why a posture exists at all

A Worker's turn runs unattended. When its child Agent asks for permission, the
daemon has nobody to ask, so `acp-permission.ts` answers `hitl-required` — which
reaches the child as `outcome: cancelled`. **Every coding Agent shipped today
reads a cancelled permission as an interrupt and aborts the whole turn.** An
Agent left on its ask-for-approval defaults is therefore born, investigates,
decides, calls its first write, and dies there with nothing committed.

That is not a theory. It was observed live for codex (`aborted by user after
0.1s`, `turn_aborted reason: interrupted`, stopReason `cancelled`) and again for
claude-code while this table was written.

**A posture is not isolation.** Isolation — a per-Worker database, a daemon-owned
home — is `acp-agent-home.ts`, and an Agent can need one without the other.

## The table

| Agent | Kind | Unattended posture | Per-Worker isolation |
| --- | --- | --- | --- |
| **redcode** | native | `none-needed` — asks for nothing inside its own workspace | `OPENCODE_DB` in the Worker workspace |
| **claude-code** | adapter | `session-mode` → `bypassPermissions`, set right after `session/new` | none |
| **codex** | adapter | `launch-args` → `-c approval_policy=never -c sandbox_mode=danger-full-access` | daemon-owned `CODEX_HOME`, seeded from the operator login |
| **pi** | adapter | `none-needed` — exposes no permission surface for tool calls | none |
| **opencode** | native | `none-needed` — same engine and same defaults as redcode | `OPENCODE_DB` in the Worker workspace |

## The evidence behind each answer

**redcode — `none-needed`.** redcode is opencode's engine, whose built-in
permission table allows every tool and allows `edit` for paths under the session
cwd and the temp dir, reserving `ask` for edits outside them. A Worker's child
runs with its own worktree as cwd, so the work it was born to do never leaves
the allowed set. This is why every live drain to date has worked unpostured.

**claude-code — `session-mode: bypassPermissions`.** Probed against the pinned
`@zed-industries/claude-code-acp@0.16.2` over stdio. `--help` prints nothing and
`dist/index.js` reads no argv at all, so **no launch flag can carry this** — the
session mode is the only door. On defaults the session opens
`currentModeId: "default"` and the first file write raises
`session/request_permission` ("Write …/PROBE.txt"); answered the way an
unattended turn answers, the turn ends with nothing written. With
`session/set_mode` → `bypassPermissions` sent first: zero permission requests,
`stopReason: "end_turn"`, the file on disk.

**codex — `launch-args`.** `codex-acp` forwards `-c key=value` into codex's own
config, so the posture rides the launch. Found by the live failure above.

**pi — `none-needed`.** `pi-acp --help` prints nothing, and `dist/index.js`
tests `process.argv` for exactly one token: `--terminal-login`. There is no
permission flag to declare. There is also nothing to declare it FOR: its only
`requestPermission` callers handle a pi *extension's* select/confirm UI, never a
tool call. The adapter runs `pi --mode rpc`, and pi reads, writes and executes
locally — its README says so under Limitations — so a write never becomes an ACP
permission request.

**opencode — `none-needed`.** The same engine and the same built-in table as
redcode, read out of the shipped `opencode` binary. The live end-to-end probe
could not be completed on the development host: `opencode acp` initialises and
then never answers `session/new` there, because no model provider is configured
for it.

## Per-Worker isolation

redcode and opencode share one branch, not one file: concurrent instances on a
single `opencode.db` die mid-turn on "database is locked" (redcode#58), so each
Worker's child gets its own DB named for its Agent inside the Worker's
disposable workspace, and the file dies with the workspace.

codex gets a daemon-owned `CODEX_HOME` instead, seeded with the operator's login
and nothing else: the first codex Worker on a host died on the operator's own
`~/.codex/config.toml` naming a model the pinned adapter cannot run.

## Adding a sixth Agent

The descriptor type REQUIRES `unattendedPosture`, so an Agent with no posture
does not compile, and the conformance matrix
(`apps/redskilled/tests/acp-agent-conformance.test.ts`) pins the table against
the catalog in both directions — an Agent with no posture fails, and a posture
for an Agent nobody can reach fails too.

Probe the artifact; do not guess a flag. `none-needed` is a legitimate answer
and requires a stated reason, because an Agent that needs nothing and an Agent
nobody checked look identical in an empty field.
