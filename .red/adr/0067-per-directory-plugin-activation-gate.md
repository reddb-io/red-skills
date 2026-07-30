# 0067 — Per-directory plugin activation gate: globally-installed RedSkills hooks stay inert until a `.red/config.yaml` opts each plugin in

## Status

Accepted.

## Context

RedSkills plugins (`dev`, `memory`, `brain`) are installed **globally** on every
agent host: their lifecycle hooks are wired into Claude Code / Codex / opencode
through each plugin's marketplace manifest, so the hooks fire on *every* session,
in *every* directory, regardless of whether that project uses RedSkills at all.

That global install is correct — we want one installation to cover every repo —
but the activation model was wrong. Before this ADR:

- The **dev** plugin's `SessionStart` hook ran `red-fetch.mjs dev <version>`
  unconditionally, warming the bundle cache (a network fetch) in any repo the
  user opened. Its `PreToolUse` hooks (branch-lock, model-tier routing) also
  fired everywhere.
- The **memory** and **brain** `bootstrap.mjs` launchers fetched their runtime
  bundle and *then* gated late — memory checked for a `plugins.memory` block
  only after the fetch + spawn had already happened (ADR 0042).
- The only "opt-in" signal was **block-presence** (`memoryConfiguredInYaml` =
  "is there a `plugins.memory` block?"), which is implicit and easy to trip.

The result: a user who did not want memory/dev/brain in a given project still
paid for them on every session — the recurring "it's always being called even
when I don't want it here" complaint. There was also no single, explicit switch
to say "this directory does not use RedSkills."

Separately, `.red/` creation had leaked: `/setup-red-skills` was *meant* to be
the sole creator of the `.red/` root, but `boot.ts`, `memory init`, and
`wiki-init` would all lazily `mkdir` under `.red/`, so a stray hook could
materialize a `.red/` in a directory that never opted in.

## Decision

Introduce a **per-directory plugin activation gate** that every hook launcher
consults *first*, before any work:

1. **Strict opt-in.** A plugin is active in a directory only when the nearest
   `.red/config.yaml` (walking up from cwd) sets `plugins.<name>.enabled: true`
   — the explicit scalar `true`. No `.red/config.yaml` anywhere → every RedSkills
   plugin is inert. A `plugins.<name>` block without `enabled: true` → inert.
   Block-presence is no longer sufficient (supersedes ADR 0042's memory opt-in
   gate "is there a `plugins.memory` block?").

2. **The gate runs pre-bundle, at the launcher.** It is implemented dependency-
   free over the same constrained-subset YAML grammar dev's config parser uses,
   so it can short-circuit *before* the bundle fetch / subprocess spawn:
   - dev: `packages/shared/plugin-gate.ts` (`isPluginEnabled`), consumed by the
     `entrypoint-cli.ts` that builds to both `red-fetch.mjs` and `afk.mjs`.
     Gated-off → `exit 0` (fetch is silent; run mode prints a one-line "not
     enabled — run /setup-red-skills" hint so a blanked statusline degrades
     gracefully and an interactive call is explained).
   - memory / brain: an inline mirror of `pluginEnabledInConfig` at the top of
     each `bootstrap.mjs` `main()` (the launchers ship as standalone `.mjs` in
     their plugin checkout and cannot import the shared module at runtime).
     Gated-off → honour the hooks' no-op contract (`{}` on stdout, `exit 0`).

3. **`/setup-red-skills` is the sole creator of a repository's `.red/` and the
   only way to enable a plugin.** It prompts which plugins to enable (Section
   A0), creates `.red/` (authorized here and nowhere else), and writes the
   `plugins.<name>.enabled` flags. **This authority is repository-scoped**: the
   operator's own `~/.red/redskilled/` is outside every checkout and belongs to
   the daemon that lives in it (ADR 0130 Amendment 1), which setup provisions by
   *calling* its owner rather than by creating the directory itself. Re-running it is how a plugin is enabled or
   disabled. Enabling memory/brain only *authorizes* them; their own init
   (`/memory:init`, brain setup) still configures them.

The gate never creates or writes anything — it only reads.

### Amendment — the complete dev hook surface (follow-up)

The first cut gated the bundle launchers (`red-fetch.mjs`, `afk.mjs`, the two
`bootstrap.mjs`) but the dev plugin fires three more hooks that do not pass
through them. They are gated too:

- **`branch-lock-hook.sh`** (Claude `PreToolUse(Bash)`) and **`branch-lock-codex.sh`**
  (Codex `PreToolUse`) ran git + file reads on *every* tool call in *every* repo.
  They now early-exit unless `plugins.dev.enabled: true` (new `dev_plugin_enabled`
  in `lib/dev-config.sh`, alongside the existing lock-flag reader).
- **`ensure-codex-statusline.mjs`** (Codex `SessionStart`) mutated the user's
  **global** `~/.codex/config.toml` on every session regardless of project. It
  now gates on `plugins.dev.enabled` (inline mirror of the gate) before touching
  anything.
- **`code-nav`** is fetched by dev's `SessionStart` hook (`red-fetch.mjs code-nav
  <ver>`) but has no `plugins.code-nav` block — it ships under the dev plugin. The
  fetch/run gate aliases `code-nav → dev` (`gatePluginName`) so it warms iff dev
  is enabled, not on a flag that is never set.

**Noise rule:** automatic, hook-fired run subcommands (`route-model-tier`,
`statusline`) are **silent** when gated off — zero stderr in a non-opted-in repo.
Only interactive invocations (e.g. `/afk`) print the one-line "run
/setup-red-skills" hint. Encouragement to run `/setup-red-skills` lives at the
interactive/skill layer, never as per-tool-call hook noise.

## Consequences

- **Breaking change / migration.** Strict opt-in means every existing repo that
  relied on block-presence (or on dev running unconditionally) goes dark until
  its `.red/config.yaml` carries `plugins.<name>.enabled: true`. The fix is to
  re-run `/setup-red-skills`. This repo's own `.red/config.yaml` gains
  `plugins.dev.enabled: true` in the same change so the live AFK fleet keeps
  running after release. Running fleets are unaffected until then: their launcher
  is version-pinned (the installed copy), so the committed launcher change only
  takes effect on the next release.

- **Performance + hygiene win.** A non-RedSkills repo now does *zero* work on
  session start — no fetch, no spawn — instead of warming a cache it never uses.

- **`enabled` is part of the config contract.** It folds the dev way
  (`plugins.dev.enabled` → `dev.enabled`) and is carried on `MemoryConfig` so the
  `memory init` write path round-trips it — `mergeMemoryBlock` preserves an
  `enabled: true` that setup wrote even though the wizard's config object does
  not know about it. The launcher gate reads the flag straight from the YAML,
  independent of the in-bundle config readers.

- **`.red/` creation authority is now explicit.** Lazy creators under `.red/`
  (`boot.ts`, `memory init`, `wiki-init`) remain, but they are reachable only
  *after* the gate has already confirmed a `.red/config.yaml` exists (so `.red/`
  is present), and `/setup-red-skills` is the documented sole creator of the
  root.

- Supersedes the ADR 0042 / ADR 0009 memory opt-in-by-block-presence gate.
  Builds on ADR 0042 (unified `.red/config.yaml`, `plugins.<name>` namespacing)
  and ADR 0038/0039 (the dependency-free launchers the gate plugs into).
