# Plugin configuration is unified under `.red/config.yaml`, namespaced by `plugins.<name>`

## Context

Each plugin resolved its own configuration, in its own place, in its own format:

- `dev` reads `.red/config.yaml` (YAML) — `afk.*` and `statusline` keys, hand-authored, read-only to the code (`src/apps/dev/src/core/config.ts`).
- `memory` read **and wrote** `.red/memory/config.json` (JSON) — `mode`, `hooks`, `notesDir`, `storePath`, `provider`, … (`src/apps/memory/src/config.ts`).

There is no shared config-resolution module; the two formats and locations diverged for no principled reason. A maintainer inspecting a repo sees two unrelated config conventions and cannot answer "where do I set plugin X?" from one place.

Two facts make unification cheap and safe:

1. **Memory's config is write-once and choice-or-default.** `writeConfig` is called in exactly two places, both the one-time `memory init` wizard (`initMarkdownOnly`, `initGraph`). Nothing mutates config at runtime — every other site only *reads*. Every persisted field is either a user's wizard answer (`mode`, `hooks` opt-in, `provider`) or a code-resolvable default (`notesDir`, `storePath`, `eventLog.retentionDays`, `l2`); `mcp`/`reddb` are pure functions of `mode`; `version` is a constant. So the "config writer" is just the wizard transcribing answers a human would otherwise type — not a continuous machine-writer fighting a hand-edited file.
2. **Both sides already have a seam.** Memory's 23 read sites all go through `readConfig`/`configPath` returning a stable `MemoryConfig`; dev's reads all go through `getConfig(cfg, "afk.*")`. The location/format can change behind those seams without touching callers.

## Decision

1. **One config file per repo: `.red/config.yaml`, namespaced by plugin under a `plugins:` key.**

   ```yaml
   # .red/config.yaml
   # (global, plugin-agnostic settings live at the top)

   plugins:
     dev:
       afk:
         default_runner: codex
         hooks:                      # user-authored shell hooks (see point 6)
           pre_session:
             - ./.red/hooks/boot.sh
     memory:
       mode: graph
       autohooks:                    # enable our built-in handlers (see point 6)
         sessionStart: true
   ```

2. **Config is sparse — only non-default choices are written; defaults live in code.** `mode` is the only mandatory `memory` field. Derivable fields are never persisted: `reddb` is derived from `mode` (graph/hybrid → true), `mcp` defaults off, `version` is the `CONFIG_VERSION` constant. `notesDir`/`storePath`/`eventLog`/`l2` are emitted only when they differ from the documented default.

3. **`memory init` emits a sparse `plugins.memory:` block into `.red/config.yaml`** (the agreed write strategy), merging into the existing file and preserving the rest. No new YAML dependency: the same constrained-subset grammar `dev` already parses (2-space-indented nested mappings, scalar leaves) is reused; a small block emitter/merger handles the write. The `MemoryConfig` interface and all `resolve*` helpers are unchanged, so the 23 read sites are untouched.

4. **The memory opt-in gate (ADR 0009) becomes "is there a `plugins.memory` block?"** `dev` soft-detects memory by reading `.red/config.yaml` for a `plugins.memory` block instead of `stat`-ing `.red/memory/config.json`. This partially supersedes ADR 0009's gate mechanism (the *direction* — dev soft-uses memory one-directionally — still stands).

5. **Back-compat, both sides, read-only fallback:**
   - `dev` reads `plugins.dev.afk.*` first, falling back to a legacy top-level `afk.*` key (older `.red/config.yaml` files keep working).
   - `memory` reads `plugins.memory` from `.red/config.yaml` first, falling back to a legacy `.red/memory/config.json` (older repos keep working until they re-init).
   - the gate accepts **either** signal.
   No automatic migration is forced; a repo upgrades the moment it re-runs `memory init` (or hand-edits the yaml). The legacy fallbacks are a deprecation lane, removable later.

6. **`hooks:` is reserved, file-wide, for user-authored shell hooks; built-in plugin hooks are code, exposed at most as an enable toggle.** Two distinct concepts must not share the `hooks:` key:
   - **User hooks** — shell interceptors the user *writes and controls*, as an ordered list of inline commands or script paths. This is the AFK lifecycle-hook model (ADR 0026), now the meaning of `hooks:` under **any** plugin namespace.
   - **Built-in hooks** — handlers the plugin *ships and owns* (memory's four auto-firing Claude Code event handlers; AFK's cargo/gradle defaults). These are not user config; where the user may toggle them, the toggle is a plain enable under a **different** key — for memory, `plugins.memory.autohooks.<event>: true` (per-event booleans), never `plugins.memory.hooks`.

   So `autohooks` (enable our handlers) and `hooks` (the user's shell) are deliberately different keys with different value shapes (booleans vs command lists). Memory writes only `autohooks`; it has no user-hook surface today.

## Consequences

- One place answers "where is plugin X configured?" — `.red/config.yaml`, under `plugins.<name>`. Future plugins (`data`, `ops`) namespace the same way.
- Memory stops owning a second config format/location; `.red/memory/` keeps only machine-written data (`graph.rdb`, `notes/`), not config. The init wizard writes the same answers, to a different (shared) file.
- The change is contained at the existing seams + a small, separately-tested `shared-config` module (parse `plugins.memory` / emit sparse block / merge into existing yaml); callers on both sides are untouched.
- The `dev → memory` detection no longer `stat`s a file; it parses the yaml for the block — a cheap parse with the existing no-dep parser, gated behind the same one-directional soft-use.
- This decision travels with the memory migration to `red-memory` (ADR 0041): the unified file/namespacing is the contract; each repo keeps its own minimal yaml handling (no cross-repo shared module), which is correct since the apps are splitting.

## Status

Accepted. Implemented behind back-compat fallbacks; the legacy `.red/memory/config.json` and top-level `afk.*` lanes are deprecated and removable in a later cleanup.

## Related

- ADR 0009 — `dev` soft-uses `memory`, one-directional. **Gate mechanism partially superseded by this ADR** (the soft-use direction stands; the probe changes from `stat .red/memory/config.json` to a `plugins.memory` block read).
- ADR 0026 — AFK lifecycle hooks declared in `.red/config.yaml` under `afk.hooks` (now `plugins.dev.afk.hooks`, with the legacy top-level lane still read).
- ADR 0041 — red-skills consumes `red-memory`/`red-ui`; this config contract travels with that migration.
