# Apply — what `--fix` runs per finding

Read this only on the `--fix` (Fix) pass. Each Pass-1 finding maps to a concrete
action and a gate: **safe** fixes apply in a batch (idempotent, low-blast-radius);
**confirm-each** fixes show the exact mutation and apply only on an explicit yes;
**delegate** fixes trigger the single-writer tool that owns the change. The
findings→owner mapping lives in the *Fix-home* table in `SKILL.md`; this table adds
the action and gate on top of it.

| Finding | `--fix` action | Gate |
|---|---|---|
| Missing canonical label | `gh label create <name> --color <c> --description "<d>"` | **safe** (batch) |
| AGENTS≡CLAUDE Agent-skills / Development-workflow parity | run the development-workflow injector (`inject-development-workflow --root <repo>`) — upserts both blocks in place | **safe** (batch; idempotent) |
| `dev.lock.primary-branch` unset | same injector (it sets the nested flag) | **safe** (batch) |
| Statusline drift | rewrite the `.claude/settings.json` `statusLine` to the cached-bundle form (jq merge, preserve other keys) | **safe** (batch) |
| `.red/.gitignore` self-ignore missing/incomplete | write `.red/.gitignore` (header + `tmp/` + `state/`) if absent, else append only the missing pattern(s) — never reorder or clobber existing lines; don't `git add` it; print a one-line receipt | **safe** (batch; idempotent) |
| Label synonym / legacy / naming | `gh label rename <old> <new>` (or create canonical + migrate, then retire the old) | **confirm each** — re-tags every issue carrying the old label |
| Legacy/top-level dev-plugin config (flat `lock-primary-branch`, top-level `dev.lock.*`, top-level `afk:`) | migrate the key(s) into the canonical `plugins.dev.*` namespace + delete the top-level orphan in `.red/config.yaml` (safe: the #697 fold reads both, the namespaced form wins) | **confirm each** |
| `blocked:*` on a `ready-for-agent`/`running` issue | `gh issue edit <N> --remove-label blocked:<reason>` (rotate the stale reason) | **confirm each** |
| MCP wiring | add/correct the expected servers in the repo's `.mcp.json` | **confirm each** |
| Version coherence mismatch | **run** the single-writer version/release tool (ADR 0040); never patch a manifest | **delegate** |
| Workflow naming-convention drift | `git mv` the file to the prefix its role requires (`reusable-*` / `rs-*` / `red-*`); filename only, body unchanged; then update any `uses:` + doc references to the old name | **confirm each** — renames a CI file |
| AFK-lane auth gap (`rs-afk-attempt.yml`, no auth secret) | **do not set the secret** — print the per-provider `gh secret set … --repo` guidance + the public-repo org-secret note; delegate to `/setup-red-skills` | **delegate** |
| AFK hook/backpressure static-validation `❌`/`⚠️` (check 12) | **`--fix` cannot auto-fix operator intent** — it cannot know whether the right repair is to rename the script, restore the file, or drop the command. Flag the finding and point at `/setup-red-skills` (re-seed a library hook) or a manual edit; never rewrite `.red/config.yaml` or `.red/hooks/` here, and never execute the command to "check" it. | **delegate** |
| Per-plugin runtime distribution `❌`/`⚠️` (check 13) | **re-trigger the launcher fetch** for the plugin (`red-fetch.mjs <plugin> <version>` / rebuild locally) — the cache is launcher-owned, never hand-edited. `cache-corrupt` also removes the bad cached file first so the re-fetch re-downloads. A re-fetch hits the network and rewrites the cache, so it is never a safe batch. | **confirm each** — a network fetch that rewrites the cache |
| `req:<Spec>` dependency edge (check 14) | **do not silently re-label** — a re-point needs the author to pick the right executable slice(s). Surface each offending edge and delegate to `/triage` (re-point) or `/to-tickets` (author the missing slice); never edit the `req:*` label here. | **delegate** |
| Native blocked-by vs `req:N` divergence (check 15) | **do not guess the canonical side** — a divergence means the authoring metadata must be refreshed. Surface each missing native edge / missing `req:N` label and delegate to `/triage`; never add/remove labels or native edges in doctor `--fix`. | **delegate** |
| Context-stack gap (check 1) | run the relevant `memory`/context skill | **delegate** |
