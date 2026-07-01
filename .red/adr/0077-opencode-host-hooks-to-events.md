# OpenCode plugin events replace Claude/Codex `claude.hooks.json` and `codex.hooks.json` with one TS module per event

## Status

accepted. Refines ADR 0075 (Slice 2 of the opencode-host plan, the
**hooks** half). The Slice 1 contract is unchanged; this ADR adds the
**hooks** surface to the generator alongside the skills surface
(ADR 0076).

## Context

Claude Code and Codex publish their hook model as JSON files
(`plugins/dev/hooks/claude.hooks.json` and `codex.hooks.json`):

- Top-level keys are **event names** (`SessionStart`, `PreToolUse`,
  `UserPromptSubmit`, …).
- Each event maps to an ordered list of `{ matcher, hooks }` groups.
- A `matcher` (e.g. `Bash`, `Task|Agent`) restricts which tool calls
  the hook fires for.
- Each `hooks` entry is a `{ type: "command", command: "sh -c '…'" }`
  shell interceptor that reads the event payload on stdin and emits
  JSON on stdout.

OpenCode's plugin model is **different** (verified against the opencode
Plugins doc, June 2026):

- A plugin is a **TypeScript/JavaScript module** that exports one or
  more `Plugin` functions.
- Each `Plugin` returns a hooks object whose **keys are event names**
  like `tool.execute.before`, `tool.execute.after`,
  `shell.env`, `experimental.session.compacting`, etc. The keys are
  camelCase strings, not nested JSON.
- The hook receives typed inputs (`input`, `output`); it does not
  shell out to read stdin. Shell hooks that need to spawn a process
  use Bun's `$` shell API (`Bun.$`).
- A plugin is loaded from `.opencode/plugins/<name>.ts` (project) or
  `~/.config/opencode/plugins/` (global). npm packages can be listed
  in `opencode.json` under `plugin: [...]`.

Two specific event classes cover everything RedSkills needs today:

- `SessionStart` (Claude/Codex) → **`config` event** in opencode
  plugins. The opencode doc shows this fires at plugin load time,
  before the TUI is interactive. Close enough for the warm-bundle
  pre-fetch the `red-fetch.mjs` shell hook performs today; the
  asymmetric note in the Slice 1 plan ("opencode runs after TUI up,
  not before") is real but the user-visible effect is identical —
  the bundle is warm before the first agent turn.
- `PreToolUse` (Claude/Codex, with `matcher: "Bash"` or
  `"Task|Agent"`) → **`tool.execute.before` event** in opencode
  plugins. The hook receives `(input, output)` where `input.tool`
  is the tool name; matching the `matcher: "Bash"` rule is a simple
  `input.tool === "bash"` (or the opencode equivalent) check inline.

The remaining events RedSkills has not yet wired (UserPromptSubmit,
PostToolUse, …) are out of scope for Slice 2 and land in a follow-up
when the source tree ships a hook for them.

## Decision

### 1. The generator emits one TS module per event class

For every event class the source plugin's `*.hooks.json` files
register, the generator writes a single
`dist/opencode/<plugin>/.opencode/plugin/<event>.ts` module. Each
module exports a `Plugin` function whose returned hooks object has
**one key** for the opencode-side event, with the matcher filter
expressed inline.

Concretely, the two event classes RedSkills ships today produce:

- `dist/opencode/<plugin>/.opencode/plugin/session-start.ts` —
  opencode `config` event, calls the union of `red-fetch.mjs` (the
  Claude/Codex `SessionStart` pre-warmer) and the Codex
  `ensure-codex-statusline.mjs` (the Codex-only statusline guard).
  Both are best-effort (`try/catch → log → continue`), matching
  the source hooks' "exit 0 always" semantics.
- `dist/opencode/<plugin>/.opencode/plugin/pre-tool-use.ts` —
  opencode `tool.execute.before` event, branches on `input.tool`:
  - `bash` → invokes the `branch-lock` shell hook (Claude source)
    or the `branch-lock-codex.sh` shell hook (Codex source),
    whichever is present in the plugin's `hooks/` directory.
  - `task` (or opencode's `task`/`agent` equivalent) → invokes
    `red-fetch.mjs run dev route-model-tier --host <detected>` so
    the AFK model-tier routing runs the same way it does under
    Claude/Codex.

The two modules are split (not merged into one `plugin/index.ts`)
because opencode's load order does not guarantee a deterministic
event order between hooks from the same module, and keeping one
file per event class makes the diff against the source `*.hooks.json`
trivial to review.

### 2. Shell commands are invoked via Bun's `$` shell API

The source `claude.hooks.json` commands are `sh -c '…'` strings that
read stdin and write JSON on stdout. The generated TS module wraps
each command in a `Bun.$` invocation, transforming the contract:

- **Stdin in / stdout out** is replaced by a typed `(input, output)`
  call: the opencode hook function gets the event payload as a
  structured object and mutates the `output` object directly
  (e.g. `output.args.command = escape(...)` for env-protection
  semantics).
- **Shell wrapping** is preserved where the source hook truly is a
  shell call (e.g. `branch-lock.sh < "$tmp"`). The TS module
  shells out via `Bun.$\`${hookPath}\`` for those paths; the
  stdin-reading pattern is replaced by an args-only invocation
  because opencode's `tool.execute.before` exposes `output.args`
  as a typed object, not a raw string.
- **Matcher logic** moves inline. A Claude `matcher: "Bash"` becomes
  `if (input.tool !== "bash") return;` at the top of the hook
  body. A `matcher: "Task|Agent"` becomes a regex test.

The `arg-mutating` semantics of the source hook (`output.args.command = escape(...)`)
is preserved exactly: opencode reads `output.args` after the hook
returns, so any mutation by the hook is honoured. The
`decision: "block"` escape-hatch (used by Claude's `branch-lock`
hook to refuse a tool call) maps to
`output.args.command = ""` plus a status string in `output.metadata`,
or — when the opencode plugin API grows a typed `block()` helper —
to the typed API directly. The Slice 2 generator uses the
mutate-and-annotate shape today; switching to a typed `block()`
helper is a one-file change in `hooks-to-events.ts`.

### 3. `${CLAUDE_PLUGIN_ROOT}` and `${CODEX_PLUGIN_ROOT}` are rewritten

The source hooks reference the plugin root via shell env vars
(`${CLAUDE_PLUGIN_ROOT}`, `${CODEX_PLUGIN_ROOT}`). OpenCode does
not define these. The generated TS module takes a `directory` (or
`worktree`) from the plugin context and uses that to resolve
relative paths to `hooks/<name>.sh` and `bin/afk.mjs` etc. The
generator's `hooks-to-events.ts` is responsible for the rewrite —
**at build time**, every `${CLAUDE_PLUGIN_ROOT}/...` /
`${CODEX_PLUGIN_ROOT}/...` reference in a source `command` string
becomes a `path.join(directory, '<plugin-root-relative>')` in the
emitted TS. This is the same rewrite ADR 0075 §Slice 1 originally
called out for the MCP layer (Slice 3), but applied here to the
hooks commands because the rewrite rule is identical.

A source hook that already uses an absolute path (e.g.
`$HOME/.codex/.tmp/marketplaces/...`) is left alone — the source
intentionally encodes a runtime-resolved path, and the rewrite
pass skips anything that does not match the env-var pattern.

### 4. The hooks-to-events module is pure

`apps/opencode-host/src/hooks-to-events.ts` exports a
`planHookModules(pluginsRoot, plugin): HookPlan[]` function. It
reads `plugins/<plugin>/hooks/<host>.hooks.json`, walks the events
present, applies the env-var rewrite, and returns a list of
`(targetPath, sourceCode)` triples. The actual file system writes
happen in `emit.ts`. The pure plan is unit-testable with no `fs`
mocking; the emit orchestration is a thin shell loop and is
smoke-tested in the CLI suite.

### 5. Fail-closed on unsupported events

If the source plugin's `*.hooks.json` registers an event the
generator does not yet handle (today: `UserPromptSubmit`,
`PostToolUse`, `Stop`, `Notification`, …), the generator logs a
warning naming the event and the matcher, and **continues
emitting** the events it does know how to map. The user is
informed, but a partial emit is preferable to a non-zero exit —
the source hooks the user actually depends on (the `red-fetch.mjs`
pre-warmer, the branch-lock guard) are the ones that get emitted.

This is a deliberate change from the Slice 1 plan's "fail-closed
on opt-in" rule: the opt-in gate (`plugins.<name>.enabled: true`)
remains fail-closed, but the hook-event mapping is
warn-and-continue so an event the generator has not yet learned
about does not block the rest of the plugin from being
discoverable. Adding support for a new event is a one-function
addition in `hooks-to-events.ts` plus a test case.

## Considered options

- **Generate one big `plugin/index.ts` with all events as keys** —
  rejected: a single 6-KB file mixing two event classes hides the
  diff against the source `*.hooks.json` and is harder to review.
  One file per event class is the convention opencode itself uses
  in its docs (see *Compaction hooks*, *Send notifications*).
- **Shell out to the source `claude.hooks.json` command via
  `Bun.$\`sh -c ${command}\``** — rejected: the env-var rewrite
  is unavoidable (opencode does not define `CLAUDE_PLUGIN_ROOT`),
  and shelling out to the raw command string keeps the
  stdin-in/stdout-out contract opencode's typed event API has
  removed. Re-using the source command verbatim is a
  compatibility trap: it would work for the current `red-fetch.
  mjs` shell hook (which exits 0 with no meaningful output) but
  silently break the next hook that wants to read a structured
  payload.
- **Reuse Claude's hook runtime as an npm dep** — rejected:
  Claude's hook runtime is not published separately and the JSON
  shape is host-specific; the typing budget of mapping
  `tool.execute.before` to `PreToolUse` correctly is smaller than
  the budget of vendoring Claude's runtime. The rewrite is the
  smaller, more honest surface.

## Consequences

- A user running `opencode .` on a reddb.io repo gets the
  pre-warmer and branch-lock guard the same way Claude/Codex do,
  with the same matcher semantics (`Bash` for branch-lock,
  `Task|Agent` for the model-tier route). The bundle is warm
  before the first agent turn; a `git checkout main` in a Claude
  hook context still fails closed under the branch-lock guard.
- The hook modules are emitted as **TypeScript**, not as a
  transpiled JS bundle. OpenCode loads TS natively (per the
  Plugins doc) and the user does not need a build step on the
  dist tree — they install the dist, opencode's Bun runtime
  transpiles on load. This matches the Slice 1 contract that
  `dist/opencode/<plugin>/` is the runtime artefact, not a
  build pipeline.
- A source hook that uses a matcher opencode does not expose
  (e.g. `matcher: "Bash|Read|Write"`) is still emitted with the
  best-effort inline filter; the user gets a warning at
  `generate` time so they know the matcher is broader than the
  source intended. Tightening the matcher to `input.tool ===
  "bash"` matches what Claude's `Bash` matcher actually does
  (case-insensitive, but Claude's matchers are glob-style; the
  inline filter is the conservative translation).
- The hook modules live under `.opencode/plugin/` and the skill
  symlinks under `.opencode/skills/` (ADR 0076). Both are
  loaded by opencode automatically from the same root, so the
  user does not have to register them in `opencode.json`. The
  `plugin:` field in `opencode.json` is reserved for npm-sourced
  plugins; project-local TS modules are auto-loaded.
- The warn-and-continue policy on unsupported events means the
  Slice 2 generator is forward-compatible with new event
  registrations: when the source adds a `UserPromptSubmit`
  hook, the generator emits everything else and prints a
  warning. A follow-up slice (3+) can add support without
  changing the Slice 2 contract.
- The Slice 1 dist tree and bundle are unchanged. Slice 2 adds
  `dist/opencode/<plugin>/.opencode/plugin/<event>.ts` and
  `dist/opencode/<plugin>/.opencode/skills/<name>/SKILL.md`
  under the same root, alongside the existing
  `dist/opencode/<plugin>/opencode.json`.

## Status

Accepted. Implements the Slice 2 hooks surface of the
opencode-host plan. Refines ADR 0075 (which scoped the adapter
contract) and complements ADR 0076 (the skills half of Slice 2).
The Slice 1 provider block, the AFK runner contract (ADR 0059),
and the bundle shape (ADR 0038/0052) are unchanged.

## Related

- **0075** — the Slice 1 decision; introduces the
  `opencode-host` app. Slice 2 extends it with skills and hooks.
- **0076** — the skills half of Slice 2; same plan, complementary
  surface.
- **0034** — monorepo definitions vs. implementation split; the
  generator reads the source `*.hooks.json` and emits the TS
  module — the source remains canonical, the dist is generated.
- **0067** — per-directory plugin activation gate; the Slice 2
  generator reuses the same `plugins.<plugin>.enabled: true`
  check from Slice 1 before emitting anything.
- **opencode Plugins doc** (June 2026) — the `config` event,
  `tool.execute.before` event, `Bun.$` shell API, and the
  `.opencode/plugins/` auto-load directory.
- **CLAUDE.md §SKILL.md body convention** — orthogonal to this
  ADR; the hook modules do not interact with the skill body
  convention.
